#!/usr/bin/env python3
"""
KHUNG CHAOS (C1 của P2): chạy một kịch bản sự cố gồm các bước dừng/khởi động container, chờ, gọi API và kiểm SQL.

  python infrastructure/chaos/run_scenario.py infrastructure/chaos/scenarios/central-down.json

Định dạng kịch bản: JSON (là tập con hợp lệ của YAML). Máy này chưa cài PyYAML, nên chưa dùng YAML thật.
Chỉ dùng thư viện chuẩn của Python. Biến bí mật (mật khẩu) được đọc từ .env theo TÊN biến, không in giá trị.

Các bước (trường "do"):
  stop / start   {"containers": [...]}                    docker stop / docker start
  wait           {"seconds": n}                           chờ n giây
  wait_healthy   {"containers": [...], "timeout": n}      chờ tới khi healthy hoặc hết thời gian
  login          {"as": "ten", "dept": "hr", "user": "hr_manager", "password_env": "DEMO_MANAGER_PASSWORD"}
  search         {"as": "ten", "q": "...", "expect_status": 200, "expect_partial": false}
  http           {"url": "...", "expect_status": 200}     GET không xác thực
  sql            {"container": "...", "db": "central"|"hr", "query": "...", "expect": "..."}

Luôn khôi phục: nếu có bước lỗi, runner vẫn khởi động lại mọi container đã dừng trong kịch bản.
Thoát mã 0 nếu mọi bước đạt, khác 0 nếu có bước lỗi.
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# Console Windows có thể dùng bảng mã cp1258: ép UTF-8 để in được tiếng Việt
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def load_env(path):
    env = {}
    with open(path, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


ENV = load_env(os.path.join(ROOT, ".env"))
BASE = "http://localhost:%s" % ENV.get("NGINX_HTTP_PORT", "8000")
ctx = {}  # token và kết quả đã lấy được, theo tên bước "as"
stopped = []  # container đã dừng, để khôi phục khi có lỗi


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")


def docker_health(name):
    r = run(["docker", "inspect", "-f", "{{.State.Health.Status}}", name])
    return r.stdout.strip()


def http_json(method, url, body=None, token=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    if token:
        req.add_header("authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8") or "null")
        except Exception:
            payload = None
        return e.code, payload


def sql_run(container, db, query):
    if db == "central":
        user, name = ENV.get("POSTGRES_CENTRAL_USER"), ENV.get("POSTGRES_CENTRAL_DB")
    else:
        user, name = ENV.get("POSTGRES_HR_USER"), ENV.get("POSTGRES_HR_DB")
    r = run(["docker", "exec", container, "psql", "-U", user, "-d", name, "-tAc", query])
    return r.stdout.strip()


def step_stop(s):
    for c in s["containers"]:
        run(["docker", "stop", c])
        stopped.append(c)
    return True, "đã dừng %s" % ", ".join(s["containers"])


def step_start(s):
    for c in s["containers"]:
        run(["docker", "start", c])
        if c in stopped:
            stopped.remove(c)
    return True, "đã khởi động %s" % ", ".join(s["containers"])


def step_wait(s):
    time.sleep(float(s["seconds"]))
    return True, "đã chờ %s giây" % s["seconds"]


def step_wait_healthy(s):
    deadline = time.time() + float(s.get("timeout", 120))
    while time.time() < deadline:
        states = [docker_health(c) for c in s["containers"]]
        if all(st == "healthy" for st in states):
            return True, "healthy: %s" % ", ".join(s["containers"])
        time.sleep(3)
    return False, "chưa healthy sau %s giây: %s" % (s.get("timeout", 120), states)


def step_login(s):
    code, body = http_json("POST", "%s/api/dept/%s/auth/login" % (BASE, s["dept"]),
                           {"username": s["user"], "password": ENV.get(s["password_env"], "")})
    token = (body or {}).get("accessToken") if isinstance(body, dict) else None
    if code not in (200, 201) or not token:  # API đăng nhập trả 201 (tạo phiên)
        return False, "đăng nhập %s/%s lỗi: HTTP %s" % (s["dept"], s["user"], code)
    ctx[s["as"]] = token
    return True, "đã đăng nhập %s/%s" % (s["dept"], s["user"])


def _search_once(s):
    q = urllib.parse.urlencode({"q": s["q"], "limit": s.get("limit", 10)})
    code, body = http_json("GET", "%s/api/search?%s" % (BASE, q), token=ctx[s["as"]])
    if code != s.get("expect_status", 200):
        return False, "tìm kiếm HTTP %s, mong đợi %s" % (code, s.get("expect_status", 200))
    if "expect_partial" in s and isinstance(body, dict) and bool(body.get("partial")) != s["expect_partial"]:
        return False, "partial=%s, mong đợi %s" % (body.get("partial"), s["expect_partial"])
    total = body.get("total") if isinstance(body, dict) else None
    return True, "HTTP %s, tổng %s, partial=%s" % (code, total, body.get("partial") if isinstance(body, dict) else None)


def step_search(s):
    # "within": số giây tối đa để đạt kỳ vọng (đo thời gian hồi phục, ví dụ sau khi cụm CSDL bật lại:
    # còn bầu máy chính, HAProxy kiểm lại, mạch ngắt của search nghỉ). Không có "within": kiểm một lần.
    within = float(s.get("within", 0))
    t0 = time.time()
    ok, detail = _search_once(s)
    while not ok and time.time() - t0 < within:
        time.sleep(2)
        ok, detail = _search_once(s)
    if within:
        detail += "; hồi phục sau %d giây (giới hạn %d)" % (time.time() - t0, within) if ok else "; chưa đạt sau %d giây" % within
    return ok, detail


def step_http(s):
    code, _ = http_json("GET", s["url"] if s["url"].startswith("http") else BASE + s["url"])
    ok = code == s.get("expect_status", 200)
    return ok, "HTTP %s, mong đợi %s" % (code, s.get("expect_status", 200))


def step_sql(s):
    got = sql_run(s["container"], s.get("db", "central"), s["query"])
    return got == str(s["expect"]), "kết quả '%s', mong đợi '%s'" % (got, s["expect"])


STEPS = {
    "stop": step_stop,
    "start": step_start,
    "wait": step_wait,
    "wait_healthy": step_wait_healthy,
    "login": step_login,
    "search": step_search,
    "http": step_http,
    "sql": step_sql,
}


def restore():
    if stopped:
        run(["docker", "start"] + list(stopped))
        print("  khôi phục: đã khởi động lại %s" % ", ".join(stopped))
        stopped.clear()


def main(path):
    with open(path, encoding="utf-8") as f:
        scenario = json.load(f)
    print("KỊCH BẢN: %s — %s" % (scenario["name"], scenario.get("description", "")))
    failed = 0
    try:
        for i, s in enumerate(scenario["steps"], 1):
            kind = s["do"]
            try:
                ok, detail = STEPS[kind](s)
            except Exception as e:  # lỗi bất ngờ của bước: ghi lại và dừng kịch bản
                ok, detail = False, "lỗi bất ngờ: %s" % e
            print("  %2d %-12s %s  %s" % (i, kind, "PASS" if ok else "FAIL", detail))
            if not ok:
                failed += 1
                break
    finally:
        restore()
    print("KẾT QUẢ %s: %s" % (scenario["name"], "ĐẠT" if failed == 0 else "CHƯA ĐẠT"))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
