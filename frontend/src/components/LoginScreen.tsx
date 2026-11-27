import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useDepartments, demoUsername } from '../context/DepartmentContext';
import { ArrowRight, Building2, Eye, EyeOff, Lock, ShieldCheck, User } from 'lucide-react';
import { APP_NAME } from '../theme';
import { Button, DeptBadge, Field, INPUT, StatusDot } from './ui';

/** Dòng đăng nhập nhanh (chỉ hiện khi build với VITE_DEMO_LOGIN=true). */
const QuickRow: React.FC<{ code: string; label: string; sub: string; disabled?: boolean; onClick: () => void }> = ({
  code,
  label,
  sub,
  disabled,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="w-full px-3 py-2 flex items-center gap-3 text-left hover:bg-slate-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
  >
    <DeptBadge code={code} />
    <span className="min-w-0 flex-1">
      <span className="block text-data font-semibold text-slate-900 truncate">{label}</span>
      <span className="block font-mono text-micro text-slate-500 truncate">{sub}</span>
    </span>
    <ArrowRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
  </button>
);

/** Màn đăng nhập: cột trái giới thiệu và tình trạng các phòng ban; cột phải là form đăng nhập. */
export const LoginScreen: React.FC = () => {
  const { login, isSigningIn } = useAuth();
  const { departments } = useDepartments();
  const showDemo = import.meta.env.VITE_DEMO_LOGIN === 'true';

  const [dept, setDept] = useState<string>('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Tự chọn phòng ban đầu tiên khi Registry trả danh sách
  useEffect(() => {
    if (!dept && departments.length > 0) {
      setDept(departments[0].code);
      if (showDemo) {
        setUsername(demoUsername(departments[0].code, 'manager'));
        setPassword('Admin@123');
      }
    }
  }, [departments, dept, showDemo]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const result = await login(dept, username, password);
    if (!result.success) {
      setErrorMessage(result.message || 'Xác thực thất bại. Vui lòng kiểm tra lại tài khoản hoặc mật khẩu.');
    }
  };

  const handleQuickLogin = async (targetDept: string, targetUser: string, targetPass: string) => {
    setDept(targetDept);
    setUsername(targetUser);
    setPassword(targetPass);
    setErrorMessage(null);

    const result = await login(targetDept, targetUser, targetPass);
    if (!result.success) {
      setErrorMessage(result.message || 'Xác thực tài khoản thất bại.');
    }
  };

  const upCount = departments.filter((d) => d.available).length;

  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-2 bg-card">
      {/* Cột trái (luôn tối, như trang đăng nhập của Shadcn Admin): giới thiệu và tình trạng các phòng ban */}
      <aside className="relative hidden lg:flex flex-col justify-between bg-zinc-950 text-zinc-300 p-10 overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-[0.07]"
          style={{ backgroundImage: 'radial-gradient(#fff 1px, transparent 1px)', backgroundSize: '22px 22px' }}
        />
        <div className="relative flex items-center gap-3">
          <span className="w-9 h-9 rounded-lg bg-brand-500 flex items-center justify-center shadow-sm">
            <Building2 className="w-[18px] h-[18px] text-white" />
          </span>
          <span className="text-base font-semibold text-white">{APP_NAME}</span>
        </div>

        <div className="relative max-w-lg">
          <h1 className="text-3xl font-bold text-white tracking-tight leading-tight">Hồ sơ của từng phòng, chia sẻ khi cần, kiểm soát mọi lúc.</h1>
          <p className="mt-4 text-sm leading-relaxed text-zinc-400">
            Mỗi phòng ban giữ tài liệu trên hệ thống riêng. Tài liệu chỉ được chia sẻ sang phòng khác khi có phê duyệt, và mọi thao tác đều được ghi nhật ký.
          </p>
        </div>

        <div className="relative max-w-lg">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-400">Tình trạng các phòng ban</span>
            {departments.length > 0 && (
              <span className="text-xs text-zinc-400">
                {upCount}/{departments.length} đang hoạt động
              </span>
            )}
          </div>
          <div className="rounded-xl border border-white/10 bg-white/[0.03] divide-y divide-white/10 overflow-hidden">
            {departments.length === 0 && <div className="px-4 h-11 flex items-center text-sm text-zinc-400">Đang tải danh sách phòng ban...</div>}
            {departments.map((d) => (
              <div key={d.code} className="px-4 h-11 flex items-center gap-3 text-sm">
                <StatusDot tone={d.available ? 'success' : 'danger'} />
                <span className="flex-1 min-w-0 truncate font-medium text-white">{d.name}</span>
                <span className="font-mono text-xs text-zinc-500">{d.code}</span>
                <span className={`w-28 text-right text-xs ${d.available ? 'text-emerald-400' : 'text-red-400'}`}>
                  {d.available ? 'Đang hoạt động' : 'Không phản hồi'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* Cột phải: form đăng nhập */}
      <main className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <span className="w-9 h-9 rounded-lg bg-brand-500 flex items-center justify-center">
              <Building2 className="w-[18px] h-[18px] text-white" />
            </span>
            <span className="text-base font-semibold text-slate-900">{APP_NAME}</span>
          </div>

          <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Đăng nhập</h2>
          <p className="mt-1 text-sm text-slate-500">Chọn phòng ban, sau đó nhập tài khoản được cấp.</p>

          <div className="mt-6">
            <div className="mb-1.5 text-xs font-medium text-slate-500">Phòng ban</div>
            {departments.length === 0 ? (
              <div className="h-10 px-3 rounded-md border border-dashed border-slate-300 flex items-center text-data text-slate-500">
                Đang tải danh sách phòng ban...
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {departments.map((d) => (
                  <button
                    key={d.code}
                    type="button"
                    disabled={!d.available}
                    title={d.available ? undefined : 'Node phòng ban hiện không sẵn sàng'}
                    onClick={() => {
                      setDept(d.code);
                      if (showDemo) setUsername(demoUsername(d.code, 'manager'));
                    }}
                    className={`h-10 px-3 rounded-md border flex items-center gap-2 text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      dept === d.code
                        ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500/15'
                        : 'border-slate-300 bg-card hover:border-slate-400'
                    }`}
                  >
                    <StatusDot tone={d.available ? 'success' : 'danger'} />
                    <span className="flex-1 min-w-0 truncate text-data font-semibold text-slate-900">{d.name}</span>
                    <span className="font-mono text-micro text-slate-500">{d.code}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {errorMessage && (
            <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-data text-red-800">
              {errorMessage}
            </div>
          )}

          <form className="mt-5 space-y-4" onSubmit={handleSubmit}>
            <Field label="Tài khoản" htmlFor="login-username">
              <div className="relative">
                <User aria-hidden="true" className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                <input
                  id="login-username"
                  type="text"
                  required
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Tên tài khoản"
                  className={`${INPUT} pl-8 font-mono`}
                />
              </div>
            </Field>

            <Field label="Mật khẩu" htmlFor="login-password">
              <div className="relative">
                <Lock aria-hidden="true" className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mật khẩu"
                  className={`${INPUT} pl-8 pr-9 font-mono`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                  className="absolute inset-y-0 right-0 flex items-center px-2.5 text-slate-400 hover:text-slate-700"
                >
                  {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </Field>

            <Button type="submit" variant="primary" disabled={isSigningIn} className="w-full h-9">
              {isSigningIn ? 'Đang xác thực...' : 'Đăng nhập'}
              {!isSigningIn && <ArrowRight className="w-3.5 h-3.5" />}
            </Button>
          </form>

          {showDemo && (
            <div className="mt-7 pt-5 border-t border-slate-200">
              <div className="mb-2 text-xs font-medium text-slate-500">Đăng nhập nhanh, tài khoản thử nghiệm</div>
              <div className="rounded-xl border border-slate-200 bg-card divide-y divide-slate-100 overflow-hidden">
                {departments.flatMap((d) => [
                  <QuickRow
                    key={`${d.code}-staff`}
                    code={d.code}
                    label={`Nhân viên ${d.name}`}
                    sub={`${demoUsername(d.code, 'staff')} · Staff@123`}
                    disabled={!d.available}
                    onClick={() => handleQuickLogin(d.code, demoUsername(d.code, 'staff'), 'Staff@123')}
                  />,
                  <QuickRow
                    key={`${d.code}-manager`}
                    code={d.code}
                    label={`Trưởng ${d.name}`}
                    sub={`${demoUsername(d.code, 'manager')} · Admin@123`}
                    disabled={!d.available}
                    onClick={() => handleQuickLogin(d.code, demoUsername(d.code, 'manager'), 'Admin@123')}
                  />,
                ])}
                <QuickRow
                  code="*"
                  label="Ban Giám đốc điều hành"
                  sub="admin · Admin@123"
                  onClick={() => handleQuickLogin(departments[0]?.code ?? dept, 'admin', 'Admin@123')}
                />
              </div>
            </div>
          )}

          <p className="mt-8 flex items-start gap-1.5 text-micro text-slate-500">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-px" />
            <span>Mỗi phiên đăng nhập gắn với phòng ban của bạn. Quyền truy cập do máy chủ xác nhận từ mã JWT.</span>
          </p>
        </div>
      </main>
    </div>
  );
};
