---
name: dms-lessons-and-skill-index
description: "BẮT BUỘC đọc đầu mỗi tác vụ trong dự án DMS: chỉ mục các skill dự án và khi nào dùng từng skill; quy trình chuẩn từ lúc nhận yêu cầu đến khi kiểm thử, ghi nhật ký, commit và chuyển sang gói kế tiếp; bài học tinh túy rút ra từ P0 đến P0.6; và cách làm lại một việc bằng các skill đã tích lũy."
---

# Chỉ mục skill, quy trình chuẩn và bài học của dự án DMS

## 1. Chỉ mục skill: đọc đúng cái cần

| Skill | Khi nào dùng | Tệp |
|---|---|---|
| `dms-engineering-principles` | Mọi tác vụ: chính trực, phản biện có căn cứ, bảng sự cố, an toàn dữ liệu | `.claude/skills/dms-engineering-principles/SKILL.md` |
| `plan-before-code` | Mọi phản hồi, đề xuất, yêu cầu thay đổi. Chỉ viết mã sau khi có câu "chốt" | `.claude/skills/plan-before-code/SKILL.md` |
| `dms-incident-playbook` | Chẩn đoán hoặc sửa sự cố: Kafka và CDC, projector, CSDL trung tâm, registry, node, SLA, Docker/Windows | `.claude/skills/dms-incident-playbook/SKILL.md` |
| `dms-progress-tracking` | Sau mỗi tác vụ, mỗi lần chốt, commit, e2e, sự cố | `.claude/skills/dms-progress-tracking/SKILL.md` |
| `dms-lessons-and-skill-index` | Đầu mỗi tác vụ (tệp này) | `.claude/skills/dms-lessons-and-skill-index/SKILL.md` |

Tài liệu trạng thái: `docs/07` (hiện trạng từng gói), `docs/10` (lộ trình P0 → P3 và quyết định cần chốt), `docs/11` (runbook P1 và điều kiện C1–C4), `docs/12` (nhật ký theo thời gian).

## 2. Quy trình chuẩn cho một tác vụ

1. **Đọc.** Skill này, `dms-engineering-principles`, mục cuối của `docs/12`, và mục liên quan trong `docs/07`.
2. **Hiểu đúng.** Tóm tắt yêu cầu bằng lời của mình, nêu giả định. Hỏi trước nếu có chỗ mơ hồ.
3. **Đo hiện trạng.** Số thật: RAM, container, image, tiến độ, log. Không dựa vào số trong tài liệu cũ.
4. **Trình kế hoạch** theo mẫu của `plan-before-code`: mục tiêu, phương án và lý do, phương án khác, rủi ro, cách kiểm chứng, đường lùi. Nếu có thay đổi mã, hạ tầng hoặc dữ liệu thì **chờ câu "chốt"**.
5. **Sau khi chốt:** sửa mã → build bằng builder cũ (`DOCKER_BUILDKIT=0`) → kiểm mã trong image → recreate container (không restart) → kiểm thử ca nhắm đúng việc vừa sửa → e2e đầy đủ (hồi quy) → đối chiếu log.
6. **Ghi nhật ký** theo `dms-progress-tracking`. Cập nhật `docs/07` nếu trạng thái đổi.
7. **Commit** chỉ khi người dùng yêu cầu. Chỉ stage đúng phạm vi. Không commit `.env`, `departments/*.env`, `.claude/`, và `AGENTS.md` trừ khi được yêu cầu rõ. Quét diff tìm bí mật trước khi commit (chỉ đếm dòng nghi ngờ, không in giá trị).
8. **Chuyển sang việc kế tiếp** trong lộ trình nếu không bị chặn. Nếu bị chặn (thiếu điều kiện, cần quyết định, hành động không đảo ngược), dừng và nêu đúng điều kiện còn thiếu cùng một câu hỏi cụ thể.

## 3. Bài học tinh túy (đáng giữ lại)

Mỗi bài học có: vì sao quan trọng, và áp dụng khi nào.

1. **Số đo trước, kết luận sau.** Vì sao: nginx `rt` đã bác bỏ giả thuyết "trung tâm gây chậm" trong khi client báo 1426 ms. Áp dụng: mọi kết luận về hiệu năng.
2. **Kiểm giả định của test trước khi nghi sản phẩm.** Vì sao: ba lần sai đều nằm ở test (số 7 ghi cứng, lag `-` của partition trống, dừng một bản HA). Áp dụng: khi test đỏ mới xuất hiện.
3. **Đo đúng lớp.** Vì sao: đo client trong Git Bash bị nhiễu khi máy thiếu RAM. Áp dụng: mọi số SLA; dùng `time_total` trong một tiến trình hoặc đối chiếu `urt`.
4. **Mã trong image là bằng chứng.** Vì sao: build có thể báo thành công nhưng thiếu mã. Áp dụng: trước mọi lần recreate, grep JS đã biên dịch.
5. **Recreate, không restart, khi đổi image.** Vì sao: `docker restart` giữ image cũ. Áp dụng: mọi thay đổi mã đã build. Dùng `--no-deps` để không đụng CSDL.
6. **Thí nghiệm A/B để chứng minh nhân quả.** Vì sao: "lag về 0" không chứng minh được commit đã chạy. Đặt offset lùi rồi xem nó trở lại mới chứng minh. Áp dụng: khi cần chứng minh một đường mã cụ thể đã chạy.
7. **Idempotency và guard phiên bản là nền của tự phục hồi.** Vì sao: `GREATEST`, `source_version` và dấu vân tay cho phép đọc lại an toàn. Giới hạn: reset không dựng lại chỉ mục; đối soát vẫn cần resync.
8. **Tài nguyên là ràng buộc thật.** Vì sao: RAM Windows dao động 1,2–1,9 GB, commit gần đầy, mọi lệnh chậm và timeout Kafka tăng. Áp dụng: ghi RAM trước mỗi cổng (gate) của P1.
9. **Lỗi phải hiện đúng chỗ và đúng mã.** Vì sao: registry trả 500 kèm stack trace gây bão đăng ký. Sửa: 503 kèm `Retry-After`; node chỉ đăng ký lại khi 404. Áp dụng: mọi endpoint phụ thuộc hạ tầng.
10. **Không tuyên bố pass khi còn FAIL.** Vì sao: e2e lần 13 là 98/1 nhưng vẫn phải ghi, dù lần sau 99/0. Áp dụng: mọi báo cáo kiểm thử.
11. **Không hạ ngưỡng để qua kiểm tra.** Áp dụng: khi SLA đỏ, tìm lớp gây chậm; sửa đo lường nếu đo sai.
12. **Hành động không đảo ngược phải hỏi trước.** Vì sao: đã từng restart Docker và `wsl --shutdown` trước khi hỏi. Áp dụng: recreate Kafka, xóa topic, đổi dữ liệu, sửa lịch sử git.
13. **Lệnh nặng chạy nền.** Vì sao: grep log lớn treo shell khi máy thiếu RAM. Áp dụng: mọi lệnh có thể quá 120 s; không chạy song song với test đo thời gian.
14. **Ghi nhận rủi ro thật.** Vì sao: log Kafka nằm trong `/tmp`, bí mật còn trong lịch sử git, pool trung tâm có thể xếp hàng. Áp dụng: luôn đưa vào mục "Còn mở" của nhật ký.
15. **Replica HA che giấu sự cố.** Vì sao: `dept-hr-2` cùng alias khiến HR vẫn trả lời khi một bản dừng. Áp dụng: mọi kịch bản "node sập" phải dừng toàn bộ bản sao.

## 4. Sai lầm đã mắc và cách tránh

- Restart Docker Desktop hoặc `wsl --shutdown` trước khi hỏi. Tránh: chốt trước.
- Tin mã thoát 0 của chuỗi lệnh nền có `echo` ở cuối. Tránh: đọc dòng `exit=` trong file.
- Kết luận lag do thiếu commit khi chưa kiểm. Thực tế là test đếm partition trống. Tránh: kiểm `--describe` trước.
- Để số kỳ vọng ghi cứng trong test. Tránh: đếm từ CSDL hoặc từ nguồn sự thật.
- Cho rằng dừng một replica là đủ để mô phỏng node sập. Tránh: dừng cả hai.
- Kết luận server chậm từ số đo phía client. Tránh: đối chiếu nginx.
- Grep log nặng ở foreground làm treo. Tránh: chạy nền, `--tail`.
- Viết tài liệu trước khi có số liệu. Tránh: nhãn "chưa kiểm chứng".
- Sửa tài liệu cũ chỉ theo trí nhớ. Tránh: đo lại và ghi đính chính.

## 5. Cách làm lại một việc bằng skill đã có

Ví dụ: làm P1 B1 (Kafka 3 broker).

1. Đọc skill này, `dms-incident-playbook` (mục Kafka), `docs/11` (điều kiện C1–C4).
2. Đo C1 (RAM trống) ít nhất ba lần, cách nhau một khoảng. Ghi số vào nhật ký.
3. Kiểm C2 (cửa sổ bảo trì đã được người dùng chốt), C3 (sao lưu log Kafka ra nơi bền, không phải `/tmp` hay scratchpad, và đã kiểm đọc được).
4. Nếu còn thiếu điều kiện nào: **dừng**, báo đúng điều kiện còn thiếu, không tự làm.
5. Khi đủ điều kiện: lập kế hoạch theo mẫu `plan-before-code` (có đường lùi), chờ chốt; rồi thực hiện theo 11 bước trong `docs/11`; kiểm `ha-minisr-test` và `kafka-failover-test` theo runbook; ghi nhật ký.

Ví dụ khác: sửa một lỗi kiểm thử.
1. Tái hiện bằng số đo; xác định test sai hay sản phẩm sai (xem mục 3.2).
2. Sửa đúng chỗ; không hạ ngưỡng.
3. Build, kiểm mã trong image, recreate nếu cần, chạy ca nhắm đúng, rồi e2e đầy đủ.
4. Ghi cả lần FAIL và lần PASS vào nhật ký.

## 6. Trạng thái lộ trình và điều kiện chặn (cập nhật 2026-11-20)

- **P0** (`docs/10` mục 5): đã có N5 (đua duyệt), N1 (sao lưu và diễn tập khôi phục), N7 (kafka-exporter và cảnh báo lag), đóng cổng. Bổ sung P0.5 và P0.6, và sửa registry 503 (`6c6de8f`). Còn mở: pool trung tâm khi sập; dòng tiến độ `legal` cũ; bí mật trong lịch sử git; `.dockerignore`.
- **P1 B1** (Kafka 3 broker): chặn bởi C1 (RAM trống ≥ 2 GB ổn định; lần đo gần nhất 1,92 GB), C2 (cửa sổ khoảng 10 phút, chờ người dùng), C3 (sao lưu log Kafka bền). Quyết định dừng `k8s-lab-control-plane` (khoảng 0,7 GB) còn chờ xác nhận. Hướng A ước tính thêm khoảng 1,3 GB cho hai broker.
- **P1 B2** (Patroni CSDL trung tâm): cần thêm container, nên chịu cùng ràng buộc RAM. Cần thiết kế riêng.
- **P1 N3** (đối soát tự động): có thể thiết kế và kiểm trên hạ tầng hiện có. Chưa bắt đầu.
- **P2**: N2 (Patroni HR) cần B2 xong và quyết định PostgreSQL 16 hay 17 (`docs/10` mục 7 câu 4). C1 (chaos), C2 (autoscaler, đã có N7).
- **P3**: N4, N6, B4, C3 và các mục chỉ làm khi có số đo.
