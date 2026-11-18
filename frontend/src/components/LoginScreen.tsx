import React, { useEffect, useState, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useDepartments, deptTone, demoUsername } from '../context/DepartmentContext';
import {
  Lock,
  User,
  Building2,
  Eye,
  EyeOff,
  Loader2,
  ArrowRight,
  Database,
  ShieldCheck,
} from 'lucide-react';

export const LoginScreen: React.FC = () => {
  const { login, isLoading } = useAuth();
  const { departments } = useDepartments();
  const showDemo = import.meta.env.VITE_DEMO_LOGIN === 'true';

  const [dept, setDept] = useState<string>('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Auto-select first department when Registry loads
  useEffect(() => {
    if (!dept && departments.length > 0) {
      setDept(departments[0].code);
      if (showDemo) {
        setUsername(demoUsername(departments[0].code, 'manager'));
        setPassword('Admin@123');
      }
    }
  }, [departments, dept, showDemo]);

  // Clean ambient particle mesh
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    let width = (canvas.width = window.innerWidth);
    let height = (canvas.height = window.innerHeight);

    const handleResize = () => {
      if (!canvas) return;
      width = canvas.width = window.innerWidth;
      height = canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', handleResize);

    const particleCount = Math.min(45, Math.floor((width * height) / 28000));
    const particles = Array.from({ length: particleCount }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.35,
      vy: (Math.random() - 0.5) * 0.35,
      radius: Math.random() * 1.5 + 1,
    }));

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      const bgGrad = ctx.createRadialGradient(
        width / 2,
        height * 0.4,
        40,
        width / 2,
        height * 0.5,
        Math.max(width, height)
      );
      bgGrad.addColorStop(0, '#0f172a');
      bgGrad.addColorStop(0.7, '#090d16');
      bgGrad.addColorStop(1, '#020617');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0 || p.x > width) p.vx *= -1;
        if (p.y < 0 || p.y > height) p.vy *= -1;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.4)';
        ctx.fill();

        for (let j = i + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dist = Math.hypot(p.x - p2.x, p.y - p2.y);
          if (dist < 130) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = `rgba(56, 189, 248, ${0.15 * (1 - dist / 130)})`;
            ctx.lineWidth = 0.75;
            ctx.stroke();
          }
        }
      }

      animId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const result = await login(dept, username, password);
    if (!result.success) {
      setErrorMessage(result.message || 'Xác thực thất bại. Vui lòng kiểm tra lại tài khoản hoặc mật khẩu.');
    }
  };

  const handleQuickLogin = async (
    targetDept: string,
    targetUser: string,
    targetPass: string,
    targetExec = false,
  ) => {
    setDept(targetDept);
    setUsername(targetUser);
    setPassword(targetPass);
    setErrorMessage(null);

    const result = await login(targetDept, targetUser, targetPass);
    if (!result.success) {
      setErrorMessage(result.message || 'Xác thực tài khoản thất bại.');
    }
  };

  return (
    <div className="relative min-h-screen flex flex-col justify-center py-10 px-4 sm:px-6 lg:px-8 overflow-hidden select-none">
      {/* Background Live Particle Canvas */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none z-0 block w-full h-full"
      />

      <div className="relative z-10 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center mb-3">
          <div className="w-11 h-11 rounded-lg bg-slate-900 border border-slate-700 flex items-center justify-center text-white shadow-lg">
            <Building2 className="w-5 h-5 text-sky-400" />
          </div>
        </div>

        <h1 className="text-center text-lg font-bold tracking-tight text-white uppercase">
          DMS Enterprise Platform
        </h1>
        <p className="mt-0.5 text-center text-xs text-slate-400">
          Cổng Quản Trị Tài Liệu Doanh Nghiệp Phân Tán
        </p>
      </div>

      <div className="relative z-10 mt-6 sm:mx-auto sm:w-full sm:max-w-xl">
        <div className="bg-white py-6 px-6 sm:px-8 rounded-lg border border-slate-200 shadow-xl space-y-4">
          {/* Department Workspace Selector */}
          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
              Chọn Cụm Phòng Ban
            </label>
            <div className="flex flex-wrap gap-2 p-1 bg-slate-100 rounded-md">
              {departments.length === 0 && (
                <div className="flex-1 py-2 px-3 text-xs text-slate-500 text-center">
                  Đang tải danh sách phòng ban...
                </div>
              )}
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
                  className={`flex-1 min-w-[7.5rem] py-2 px-3 text-xs font-bold rounded transition-all flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed ${
                    dept === d.code
                      ? 'bg-white text-slate-900 shadow-xs border border-slate-300'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Database className={`w-3.5 h-3.5 ${deptTone(d.code).text}`} />
                  {d.name}
                </button>
              ))}
            </div>
          </div>

          {/* Error Notice */}
          {errorMessage && (
            <div className="p-3 rounded bg-red-50 border border-red-200 text-xs text-red-700 flex items-start gap-2">
              <span className="font-bold">Lỗi:</span>
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Form */}
          <form className="space-y-3.5" onSubmit={handleSubmit}>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Tài khoản</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <User className="h-4 w-4" />
                </div>
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Tên tài khoản..."
                  className="block w-full pl-9 pr-3 py-2 text-xs rounded border border-slate-300 focus:ring-1 focus:ring-sky-600 focus:border-sky-600 text-slate-900 font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Mật khẩu</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Lock className="h-4 w-4" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mật khẩu..."
                  className="block w-full pl-9 pr-9 py-2 text-xs rounded border border-slate-300 focus:ring-1 focus:ring-sky-600 focus:border-sky-600 text-slate-900 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600"
                >
                  {showPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full mt-2 py-2 px-4 rounded bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Đang xác thực thông tin...
                </>
              ) : (
                <>
                  Đăng Nhập Hệ Thống
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </form>

          {/* Quick Login by Enterprise Roles */}
          {showDemo && (
            <div className="pt-3 border-t border-slate-100 space-y-2">
              <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                Đăng nhập nhanh (Tài khoản kiểm thử)
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {departments.flatMap((d) => [
                  <button
                    key={`${d.code}-staff`}
                    type="button"
                    onClick={() => handleQuickLogin(d.code, demoUsername(d.code, 'staff'), 'Staff@123', false)}
                    className="p-2.5 rounded border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-colors text-left text-xs"
                  >
                    <div className="font-semibold text-slate-800 flex items-center justify-between">
                      <span>Nhân viên {d.name}</span>
                      <span className="text-[10px] bg-slate-100 text-slate-600 px-1 rounded font-mono">
                        {d.code} STAFF
                      </span>
                    </div>
                    <div className="text-slate-400 text-[10px] mt-0.5 font-mono">
                      {demoUsername(d.code, 'staff')} / Staff@123
                    </div>
                  </button>,
                  <button
                    key={`${d.code}-manager`}
                    type="button"
                    onClick={() => handleQuickLogin(d.code, demoUsername(d.code, 'manager'), 'Admin@123', false)}
                    className={`p-2.5 rounded border bg-white hover:bg-slate-50 transition-colors text-left text-xs ${deptTone(d.code).badge}`}
                  >
                    <div className="font-semibold flex items-center justify-between">
                      <span>Trưởng {d.name}</span>
                      <span className="text-[10px] bg-white/80 px-1 rounded font-mono">
                        {d.code} MANAGER
                      </span>
                    </div>
                    <div className="text-[10px] mt-0.5 font-mono opacity-80">
                      {demoUsername(d.code, 'manager')} / Admin@123
                    </div>
                  </button>,
                ])}
              </div>

              <div className="pt-0.5">
                <button
                  type="button"
                  onClick={() => handleQuickLogin(departments[0]?.code ?? dept, 'admin', 'Admin@123', true)}
                  className="w-full p-2.5 rounded border border-slate-300 bg-slate-50 hover:bg-slate-100 transition-colors text-left text-xs"
                >
                  <div className="font-semibold text-slate-900 flex items-center justify-between">
                    <span>Ban Giám Đốc Điều Hành (Executive)</span>
                    <span className="text-[10px] bg-slate-900 text-white px-1.5 py-0.5 rounded font-mono">
                      ADMIN
                    </span>
                  </div>
                  <div className="text-slate-500 text-[10px] mt-0.5">
                    Toàn quyền giám sát hệ thống và ban hành văn bản doanh nghiệp
                  </div>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Security Footer */}
        <div className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-slate-400">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          <span>Hệ thống phân tán bảo vệ cô lập dữ liệu phòng ban</span>
        </div>
      </div>
    </div>
  );
};
