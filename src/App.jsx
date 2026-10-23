import { useCallback, useEffect, useMemo, useState } from 'react';
import TrafficChart from './TrafficChart.jsx';
import { createApiClient } from './api-client.mjs';
import { formatBytes, bytesToGb, gbToBytes, dateInputValue, shortDate, relativeTime } from './formatters.mjs';
import {
  Activity,
  BarChart3,
  CalendarClock,
  CalendarPlus,
  Check,
  CircleGauge,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  LayoutDashboard,
  Link2Off,
  LockKeyhole,
  LogOut,
  Menu,
  Pencil,
  Play,
  Plus,
  RefreshCcw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
  Trash2,
  Upload,
  UserRoundCheck,
  Users,
  Wifi,
  X,
} from 'lucide-react';

const api = createApiClient();

const statusMeta = {
  active: { label: '正常', className: 'status-active' },
  suspended: { label: '已暂停', className: 'status-paused' },
  revoked: { label: '已注销', className: 'status-revoked' },
  expired: { label: '已到期', className: 'status-expired' },
  quota_exceeded: { label: '流量用尽', className: 'status-paused' },
};

function Modal({ title, children, onClose, wide = false }) {
  useEffect(() => {
    const close = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} title="关闭" aria-label="关闭"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  return <div className={`toast ${toast.type === 'error' ? 'toast-error' : ''}`}>{toast.message}</div>;
}

function AuthScreen({ bootstrap, onAuthenticated }) {
  const [mode, setMode] = useState(bootstrap.setupRequired ? 'setup' : 'login');
  const [form, setForm] = useState({ username: 'admin', password: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'setup') {
        await api('/api/setup', { method: 'POST', body: JSON.stringify(form) });
        setMode('login');
        setForm((value) => ({ ...value, password: '' }));
      } else if (mode === 'login') {
        const result = await api('/api/login', { method: 'POST', body: JSON.stringify(form) });
        api.setCsrfToken(result.csrfToken);
        onAuthenticated(result);
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-brand">
        <div className="brand-mark"><ShieldCheck size={24} /></div>
        <strong>{bootstrap.productName}</strong>
      </section>
      <form className="auth-panel" onSubmit={submit}>
        <div className="auth-heading">
          <span className="auth-symbol"><LockKeyhole size={22} /></span>
          <div><p className="eyebrow">{mode === 'setup' ? '首次设置' : '管理控制台'}</p><h1>{mode === 'setup' ? '创建管理员' : '欢迎回来'}</h1></div>
        </div>
        <label><span>管理员账号</span><input autoFocus value={form.username} autoComplete="username" onChange={(event) => setForm({ ...form, username: event.target.value })} /></label>
        <label><span>密码</span><div className="password-field"><input type={showPassword ? 'text' : 'password'} value={form.password} autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} onChange={(event) => setForm({ ...form, password: event.target.value })} /><button type="button" onClick={() => setShowPassword((value) => !value)} title={showPassword ? '隐藏密码' : '显示密码'} aria-label={showPassword ? '隐藏密码' : '显示密码'}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
        {mode === 'setup' && <p className="password-policy">至少 16 位，包含大写字母、小写字母、数字和符号中的三类。</p>}
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button auth-submit" disabled={busy}>{busy ? '处理中…' : mode === 'setup' ? '完成设置' : '登录'}</button>
      </form>
    </main>
  );
}

function MemberForm({ member, onClose, onSaved }) {
  const [form, setForm] = useState(member ? {
    name: member.name,
    note: member.note,
    expiresAt: dateInputValue(member.expiresAt),
    trafficQuotaGb: bytesToGb(member.trafficQuotaBytes),
    maxConnections: member.maxConnections,
  } : {
    name: '', note: '', durationDays: 30, trafficQuotaGb: 100, maxConnections: 2,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = {
        ...form,
        trafficQuotaBytes: gbToBytes(form.trafficQuotaGb),
        ...(member ? { expiresAt: new Date(form.expiresAt).toISOString() } : {}),
      };
      const result = await api(member ? `/api/members/${member.id}` : '/api/members', {
        method: member ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      onSaved(result.member, member ? '策略已更新' : '成员已添加');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={member ? `编辑 ${member.name}` : '添加朋友'} onClose={onClose} wide>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label className="field-span-2"><span>名称</span><input autoFocus value={form.name} onChange={(event) => update('name', event.target.value)} /></label>
          <label className="field-span-2"><span>备注</span><input value={form.note} onChange={(event) => update('note', event.target.value)} placeholder="可选" /></label>
          {member ? (
            <label className="field-span-2"><span>到期时间</span><input type="datetime-local" value={form.expiresAt} onChange={(event) => update('expiresAt', event.target.value)} /></label>
          ) : (
            <label><span>初始时长</span><div className="input-suffix"><input type="number" min="1" value={form.durationDays} onChange={(event) => update('durationDays', event.target.value)} /><em>天</em></div></label>
          )}
          <label><span>总流量</span><div className="input-suffix"><input type="number" min="0" step="1" value={form.trafficQuotaGb} onChange={(event) => update('trafficQuotaGb', event.target.value)} /><em>GB</em></div></label>
          <label><span>同时连接</span><div className="input-suffix"><input type="number" min="1" max="10" value={form.maxConnections} onChange={(event) => update('maxConnections', event.target.value)} /><em>条</em></div></label>
          <p className="field-note field-span-2">每位成员仅允许绑定一台 Windows 设备；总流量为 0 时表示不设额度。客户端通常只占用 1 条设备专线。</p>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ExtendModal({ member, onClose, onDone }) {
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api(`/api/members/${member.id}/extend`, { method: 'POST', body: JSON.stringify({ days }) });
      onDone(`已为 ${member.name} 延期 ${days} 天`);
    } finally { setBusy(false); }
  };
  return (
    <Modal title={`为 ${member.name} 延期`} onClose={onClose}>
      <form onSubmit={submit}>
        <label><span>延长时间</span><div className="input-suffix"><input autoFocus type="number" min="1" max="3650" value={days} onChange={(event) => setDays(Number(event.target.value))} /><em>天</em></div></label>
        <div className="quick-days">
          {[7, 30, 90, 365].map((value) => <button type="button" key={value} className={days === value ? 'selected' : ''} onClick={() => setDays(value)}>{value}天</button>)}
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={busy}>确认延期</button>
        </div>
      </form>
    </Modal>
  );
}

function CodeModal({ member, code, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code.code);
    setCopied(true);
  };
  return (
    <Modal title={`${member.name} 的激活码`} onClose={onClose}>
      <div className="activation-code-row">
        <code>{code.code}</code>
        <button className="icon-button" onClick={copy} title="复制激活码">{copied ? <Check size={18} /> : <Copy size={18} />}</button>
      </div>
      <p className="muted-line">{code.expiresInMinutes} 分钟后过期，仅可使用一次</p>
      <div className="modal-actions"><button className="primary-button" onClick={onClose}>完成</button></div>
    </Modal>
  );
}

function Metric({ icon: Icon, label, value, tone }) {
  return (
    <div className="metric">
      <span className={`metric-icon ${tone || ''}`}><Icon size={19} /></span>
      <div><small>{label}</small><strong>{value}</strong></div>
    </div>
  );
}

function PasswordModal({ onClose, onDone }) {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmation: '' });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    if (form.newPassword !== form.confirmation) return setError('两次输入的新密码不一致');
    setBusy(true);
    setError('');
    try {
      await api('/api/account/password', {
        method: 'POST', body: JSON.stringify({ currentPassword: form.currentPassword, newPassword: form.newPassword }),
      });
      onDone();
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="修改登录密码" onClose={onClose}>
      <form onSubmit={submit}>
        <div className="password-modal-fields">
          <label><span>当前密码</span><input autoFocus type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={form.currentPassword} onChange={(event) => update('currentPassword', event.target.value)} /></label>
          <label><span>新密码</span><input type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={form.newPassword} onChange={(event) => update('newPassword', event.target.value)} /></label>
          <label><span>确认新密码</span><input type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={form.confirmation} onChange={(event) => update('confirmation', event.target.value)} /></label>
          <label className="show-password"><input type="checkbox" checked={showPassword} onChange={(event) => setShowPassword(event.target.checked)} /><span>显示密码</span></label>
          <p className="password-policy">至少 16 位，包含大写字母、小写字母、数字和符号中的三类。</p>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy}>{busy ? '更新中…' : '更新密码'}</button></div>
      </form>
    </Modal>
  );
}

function ClientUpdateModal({ onClose, onDone }) {
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/api/client-update').then(({ policy }) => setForm({
      enabled: Boolean(policy.enabled),
      latestVersion: policy.latestVersion || '',
      minimumVersion: policy.minimumVersion || '',
      downloadUrl: policy.downloadUrl || '',
      sha256: policy.sha256 || '',
      fileSize: policy.fileSize || '',
      releaseNotes: policy.releaseNotes || '',
    })).catch((requestError) => setError(requestError.message));
  }, []);
  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/client-update', {
        method: 'PUT', body: JSON.stringify({ ...form, fileSize: Number(form.fileSize) }),
      });
      onDone();
    } catch (requestError) { setError(requestError.message); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="客户端更新策略" onClose={onClose} wide>
      {!form ? <div className="loading-state compact">正在读取发布策略…</div> : <form onSubmit={submit}>
        <div className="form-grid">
          <label><span>最新版本</span><input autoFocus value={form.latestVersion} onChange={(event) => update('latestVersion', event.target.value)} placeholder="2.3.0" /></label>
          <label><span>最低允许版本</span><input value={form.minimumVersion} onChange={(event) => update('minimumVersion', event.target.value)} placeholder="2.3.0" /></label>
          <label className="field-span-2"><span>HTTPS 下载地址</span><input value={form.downloadUrl} onChange={(event) => update('downloadUrl', event.target.value)} /></label>
          <label className="field-span-2"><span>ZIP SHA-256</span><input className="mono-input" value={form.sha256} onChange={(event) => update('sha256', event.target.value.trim())} maxLength="64" /></label>
          <label><span>文件大小（字节）</span><input type="number" min="1" value={form.fileSize} onChange={(event) => update('fileSize', event.target.value)} /></label>
          <label className="update-toggle"><input type="checkbox" checked={form.enabled} onChange={(event) => update('enabled', event.target.checked)} /><span>启用启动更新检查</span></label>
          <label className="field-span-2"><span>更新说明</span><textarea value={form.releaseNotes} onChange={(event) => update('releaseNotes', event.target.value)} rows="4" /></label>
        </div>
        <p className="field-note">最低允许版本低于当前客户端时只提示更新；高于当前客户端时会锁定连接，直到安全更新完成。</p>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy}>{busy ? '发布中…' : '发布策略'}</button></div>
      </form>}
    </Modal>
  );
}

function MemberTable({ members, onEdit, onExtend, onStatus, onResetTraffic, onResetDevice, onCode, onDelete }) {
  if (!members.length) {
    return <div className="empty-state"><Users size={24} /><strong>还没有成员</strong></div>;
  }
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th>成员</th><th>状态</th><th>设备</th><th>到期</th><th>流量额度</th><th>设备校验</th><th aria-label="操作" /></tr></thead>
        <tbody>
          {members.map((member) => {
            const status = statusMeta[member.status] || statusMeta.revoked;
            const quotaPercent = member.trafficQuotaBytes > 0 ? Math.min(100, member.trafficUsedBytes / member.trafficQuotaBytes * 100) : 0;
            return (
              <tr key={member.id}>
                <td><div className="member-name"><strong>{member.name}</strong><small>{member.note || '—'}</small></div></td>
                <td><span className={`status-pill ${status.className}`}><i />{status.label}</span></td>
                <td>{member.device ? <div className="device-cell"><span><i className={member.device.online ? 'online' : ''} />{member.device.name}</span><small>{relativeTime(member.device.lastSeenAt)}</small></div> : <span className="unbound">未绑定</span>}</td>
                <td><div className="date-cell"><span>{shortDate(member.expiresAt)}</span></div></td>
                <td><div className="traffic-cell"><span>{formatBytes(member.trafficUsedBytes)} / {member.trafficQuotaBytes ? formatBytes(member.trafficQuotaBytes) : '不限'}</span><div className="progress"><i style={{ width: `${quotaPercent}%` }} /></div></div></td>
                <td><div className="policy-cell"><span>{member.device ? '公钥 + 指纹' : '等待激活'}</span><small>{member.device?.keyProvider || `凭据版本 ${member.credentialRevision}`}</small></div></td>
                <td><div className="row-actions">
                  {member.configuredStatus !== 'revoked' && <>
                    <button className="icon-button" onClick={() => onEdit(member)} title="编辑策略"><Pencil size={16} /></button>
                    <button className="icon-button" onClick={() => onExtend(member)} title="延期"><CalendarPlus size={16} /></button>
                    <button className="icon-button" onClick={() => onCode(member)} title="生成激活码"><KeyRound size={16} /></button>
                    <button className="icon-button" onClick={() => onStatus(member, member.configuredStatus === 'suspended' ? 'active' : 'suspended')} title={member.configuredStatus === 'suspended' ? '恢复使用' : '暂停使用'}>{member.configuredStatus === 'suspended' ? <Play size={16} /> : <SlidersHorizontal size={16} />}</button>
                  </>}
                  <div className="more-menu">
                    <button className="icon-button" title="更多操作"><Menu size={16} /></button>
                    <div className="more-popover">
                      {member.configuredStatus === 'revoked' ? (
                        <button className="danger-action" onClick={() => onDelete(member)}><Trash2 size={15} />永久删除</button>
                      ) : <>
                        <button onClick={() => onResetTraffic(member)}><RefreshCcw size={15} />清零流量</button>
                        <button onClick={() => onResetDevice(member)}><Link2Off size={15} />解绑设备</button>
                        <button className="danger-action" onClick={() => onStatus(member, 'revoked')}><X size={15} />注销成员</button>
                      </>}
                    </div>
                  </div>
                </div></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Dashboard({ bootstrap, session, onLogout }) {
  const [data, setData] = useState(null);
  const [audit, setAudit] = useState([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [showMemberForm, setShowMemberForm] = useState(false);
  const [extending, setExtending] = useState(null);
  const [codeState, setCodeState] = useState(null);
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);

  const notify = useCallback((message, type = 'success') => {
    setToast({ message, type });
    window.setTimeout(() => setToast(null), 2800);
  }, []);

  const load = useCallback(async () => {
    try {
      const [dashboard, auditResult] = await Promise.all([api('/api/dashboard'), api('/api/audit?limit=10')]);
      setData(dashboard);
      setAudit(auditResult.logs);
      setLastUpdated(new Date());
    } catch (error) {
      notify(error.message, 'error');
    } finally { setLoading(false); }
  }, [notify]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const members = useMemo(() => {
    if (!data) return [];
    const query = search.trim().toLowerCase();
    return data.members.filter((member) => {
      const matchesSearch = !query || `${member.name} ${member.note}`.toLowerCase().includes(query);
      const matchesStatus = statusFilter === 'all' || member.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [data, search, statusFilter]);

  const topMembers = useMemo(() => (data?.members || [])
    .filter((member) => member.trafficUsedBytes > 0)
    .sort((left, right) => right.trafficUsedBytes - left.trafficUsedBytes)
    .slice(0, 5), [data]);
  const topTraffic = topMembers[0]?.trafficUsedBytes || 1;

  const runMemberAction = async (member, action, body, message, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      await api(`/api/members/${member.id}/${action}`, { method: 'POST', body: JSON.stringify(body || {}) });
      notify(message);
      await load();
    } catch (error) { notify(error.message, 'error'); }
  };

  const generateCode = async (member) => {
    try {
      const result = await api(`/api/members/${member.id}/activation-code`, { method: 'POST', body: JSON.stringify({ expiresInMinutes: 30 }) });
      setCodeState({ member, code: result });
      await load();
    } catch (error) { notify(error.message, 'error'); }
  };

  const deleteMember = async (member) => {
    if (!window.confirm(`确定永久删除 ${member.name}？成员、设备历史和激活记录都将删除，此操作无法撤销。`)) return;
    try {
      await api(`/api/members/${member.id}`, { method: 'DELETE' });
      notify(`${member.name} 已永久删除`);
      await load();
    } catch (error) { notify(error.message, 'error'); }
  };

  const logout = async () => {
    await api('/api/logout', { method: 'POST' });
    api.clearSession();
    onLogout();
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><div className="brand-mark"><ShieldCheck size={20} /></div><strong>{bootstrap.productName}</strong></div>
        <nav>
          <a className="nav-item active" href="#overview"><LayoutDashboard size={18} /><span>运行概览</span></a>
          <a className="nav-item" href="#members"><Users size={18} /><span>成员管理</span></a>
          <a className="nav-item" href="#activity"><Activity size={18} /><span>操作记录</span></a>
        </nav>
        <div className="sidebar-settings">
          <button className="nav-item" onClick={() => setShowUpdateModal(true)} title="客户端更新" aria-label="客户端更新"><Download size={18} /><span>客户端更新</span></button>
          <button className="nav-item" onClick={() => setShowPasswordModal(true)} title="修改密码" aria-label="修改密码"><Settings size={18} /><span>修改密码</span></button>
        </div>
        <div className="sidebar-account"><span>{session.username.slice(0, 1).toUpperCase()}</span><div><strong>{session.username}</strong><small>管理员</small></div><button className="icon-button dark" onClick={logout} title="退出登录"><LogOut size={17} /></button></div>
      </aside>
      <main className="main-content">
        <header className="page-header"><div><p className="eyebrow">节点管理</p><h1>网络运行中心</h1></div><div className="header-actions"><span className="node-health"><i />洛杉矶节点运行中</span><button className="primary-button" onClick={() => { setEditing(null); setShowMemberForm(true); }}><Plus size={17} />添加朋友</button></div></header>
        {loading || !data ? <div className="loading-state">正在加载…</div> : <>
          {data.summary.failedJobs > 0 && <div className="sync-alert" role="alert">
            <RefreshCcw size={17} /><span>{data.summary.failedJobs} 条代理策略同步失败，系统正在自动重试。</span>
          </div>}
          <section id="overview" className="metrics-band" aria-label="使用概况">
            <Metric icon={Users} label="全部成员" value={data.summary.total} />
            <Metric icon={UserRoundCheck} label="正常使用" value={data.summary.active} tone="green" />
            <Metric icon={Wifi} label="当前在线" value={data.summary.online} tone="blue" />
            <Metric icon={CalendarClock} label="七天内到期" value={data.summary.expiringSoon} tone="amber" />
            <Metric icon={Activity} label="累计流量" value={formatBytes(data.summary.trafficUsedBytes)} />
          </section>

          <section className="insights-grid">
            <TrafficChart api={api} members={data.members} />
            <TrafficChart api={api} members={data.members} individual />
            <section className="ranking-panel ranking-wide" aria-label="流量排行">
              <div className="panel-heading"><div><span className="section-icon amber"><TrendingUp size={18} /></span><div><h2>流量排行</h2><p>累计使用量</p></div></div></div>
              <div className="ranking-list">
                {topMembers.length ? topMembers.map((member, index) => <div className="ranking-row" key={member.id}><span className="rank-number">{index + 1}</span><div><p><strong>{member.name}</strong><span>{formatBytes(member.trafficUsedBytes)}</span></p><div className="rank-bar"><i style={{ width: `${member.trafficUsedBytes / topTraffic * 100}%` }} /></div></div></div>) : <div className="ranking-empty"><TrendingUp size={22} /><span>暂无流量记录</span></div>}
              </div>
              <div className="node-summary"><span className="section-icon green"><Server size={17} /></span><div><strong>US-LAX-ISP-1</strong><small>{lastUpdated ? `${relativeTime(lastUpdated)}更新` : '正在同步'}</small></div><span className="live-dot">在线</span></div>
            </section>
          </section>

          <section id="members" className="members-section">
            <div className="section-heading"><div><h2>成员与策略</h2><span>{members.length} 条记录</span></div><div className="table-tools"><label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索成员" /></label><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="状态筛选"><option value="all">全部状态</option><option value="active">正常</option><option value="suspended">已暂停</option><option value="expired">已到期</option><option value="quota_exceeded">流量用尽</option><option value="revoked">已注销</option></select></div></div>
            <MemberTable
              members={members}
              onEdit={(member) => { setEditing(member); setShowMemberForm(true); }}
              onExtend={setExtending}
              onCode={generateCode}
              onStatus={(member, status) => runMemberAction(member, 'status', { status }, status === 'active' ? `${member.name} 已恢复` : status === 'suspended' ? `${member.name} 已暂停` : `${member.name} 已注销`, status === 'revoked' ? `确定注销 ${member.name}？该设备的凭据将立即失效。` : null)}
              onResetTraffic={(member) => runMemberAction(member, 'reset-traffic', {}, `${member.name} 的流量已清零`, `确定清零 ${member.name} 的流量统计？`)}
              onResetDevice={(member) => runMemberAction(member, 'reset-device', {}, `${member.name} 的设备已解绑`, `确定解绑 ${member.name} 当前设备？旧设备将无法继续领取凭据。`)}
              onDelete={deleteMember}
            />
          </section>

          <section id="activity" className="activity-section">
            <div className="section-heading"><div><h2>最近操作</h2><span>审计记录</span></div></div>
            <div className="audit-list">{audit.map((item) => <div className="audit-row" key={item.id}><span className="audit-icon"><CircleGauge size={15} /></span><p>{item.detail}</p><time>{relativeTime(item.createdAt)}</time></div>)}</div>
          </section>
        </>}
      </main>
      {showMemberForm && <MemberForm member={editing} onClose={() => setShowMemberForm(false)} onSaved={async (_, message) => { setShowMemberForm(false); notify(message); await load(); }} />}
      {extending && <ExtendModal member={extending} onClose={() => setExtending(null)} onDone={async (message) => { setExtending(null); notify(message); await load(); }} />}
      {codeState && <CodeModal member={codeState.member} code={codeState.code} onClose={() => setCodeState(null)} />}
      {showPasswordModal && <PasswordModal onClose={() => setShowPasswordModal(false)} onDone={() => { setShowPasswordModal(false); notify('登录密码已更新，其他会话已退出'); }} />}
      {showUpdateModal && <ClientUpdateModal onClose={() => setShowUpdateModal(false)} onDone={() => { setShowUpdateModal(false); notify('客户端更新策略已发布'); }} />}
      <Toast toast={toast} />
    </div>
  );
}

export default function App() {
  const [bootstrap, setBootstrap] = useState(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  const initialize = useCallback(async () => {
    try {
      const state = await api('/api/bootstrap');
      setBootstrap(state);
      if (!state.setupRequired) {
        try {
          const me = await api('/api/me');
          api.setCsrfToken(me.csrfToken);
          setSession(me);
        } catch { api.clearSession(); setSession(null); }
      }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { initialize(); }, [initialize]);
  if (loading || !bootstrap) return <div className="splash"><ShieldCheck size={28} /></div>;
  if (!session) return <AuthScreen bootstrap={bootstrap} onAuthenticated={setSession} />;
  return <Dashboard bootstrap={bootstrap} session={session} onLogout={() => setSession(null)} />;
}
