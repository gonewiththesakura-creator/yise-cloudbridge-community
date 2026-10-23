import { useEffect, useId, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, BarChart3, RefreshCcw, Users } from 'lucide-react';
import { smoothSegments } from './chart-geometry.mjs';

function bytes(value) {
  if (!value) return '0 B';
  const unit = Math.min(4, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))));
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}

function label(at, unit) {
  return new Intl.DateTimeFormat('zh-CN', unit === 'hour'
    ? { hour: '2-digit', minute: '2-digit' } : { month: '2-digit', day: '2-digit' }).format(new Date(at));
}

export default function TrafficChart({ api, members, individual = false }) {
  const [range, setRange] = useState('24h');
  const [selection, setSelection] = useState('');
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  const [hovered, setHovered] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const id = useId().replaceAll(':', '');
  const memberId = individual ? (members.some((member) => member.id === selection) ? selection : members[0]?.id) : null;
  const memberName = members.find((member) => member.id === memberId)?.name;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setHovered(null);
    setState({ data: null, loading: true, error: '' });
    if (individual && !memberId) {
      setState({ data: null, loading: false, error: '' });
      return () => controller.abort();
    }
    const load = async () => {
      try {
        const query = new URLSearchParams({ range });
        if (memberId) query.set('memberId', memberId);
        const data = await api(`/api/traffic?${query}`, { signal: controller.signal });
        if (active) setState({ data, loading: false, error: '' });
      } catch (error) {
        if (active) setState((current) => ({ ...current, loading: false, error: error.message }));
      }
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => { active = false; controller.abort(); window.clearInterval(timer); };
  }, [api, range, memberId, individual, refresh]);

  const { data, loading, error } = state;
  const points = data?.points || [];
  const sampled = points.filter((point) => point.observed);
  const maximum = Math.max(1024, ...sampled.flatMap((point) => [point.uploadBytes, point.downloadBytes])) * 1.12;
  const width = 660;
  const height = 176;
  const coordinateX = (index) => index / Math.max(1, points.length - 1) * width;
  const tickIndices = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].filter((index) => points[index]);
  const focus = hovered === null ? null : points[hovered];
  const totals = data?.totals;
  const title = individual ? '用户流量' : '总流量';
  const empty = individual && !memberId ? '添加成员后，即可查看独立流量曲线' : '这段时间还没有采样记录';

  return <section className="chart-panel glass-chart" aria-label={`${title}上下行统计`}>
    <div className="panel-heading">
      <div><span className={`section-icon ${individual ? 'violet' : 'blue'}`}>{individual ? <Users size={18} /> : <BarChart3 size={18} />}</span><div><h2>{title}</h2><p>{individual ? '按成员独立统计' : '当前成员的流量汇总'}</p></div></div>
      <div className="segmented" aria-label={`${title}时间范围`}>
        {[['24h', '24小时'], ['7d', '7天'], ['30d', '30天']].map(([value, name]) => <button key={value} aria-pressed={range === value} className={range === value ? 'selected' : ''} onClick={() => setRange(value)}>{name}</button>)}
      </div>
    </div>
    <div className="chart-context">
      {individual ? <label className="chart-member-picker"><Users size={14} /><select aria-label="选择流量统计用户" value={memberId || ''} disabled={!members.length} onChange={(event) => setSelection(event.target.value)}>{!members.length && <option value="">暂无成员</option>}{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label> : <span>全部 {members.length} 位成员</span>}
      <span>{data?.unit === 'day' ? '每日' : '每小时'}流量 · 每 30 秒刷新</span>
    </div>
    <div className="traffic-totals">
      <div><span className="total-symbol download"><ArrowDownLeft size={20} /></span><div><small>区间下载</small><strong>{totals ? bytes(totals.downloadBytes) : '—'}</strong></div></div>
      <div><span className="total-symbol upload"><ArrowUpRight size={20} /></span><div><small>区间上传</small><strong>{totals ? bytes(totals.uploadBytes) : '—'}</strong></div></div>
      <div className="total-combined"><small>合计</small><strong>{totals ? bytes(totals.totalBytes) : '—'}</strong></div>
    </div>
    <div className={`chart-wrap ${loading ? 'is-loading' : ''}`} aria-busy={loading}>
      <div className="chart-legend"><span><i className="download-dot" />下载</span><span><i className="upload-dot" />上传</span></div>
      <svg className="traffic-chart" viewBox="-62 -12 740 226" role="img" aria-label={`${individual ? memberName || '用户' : '全部成员'}上下行流量曲线，空缺代表没有采样`} onPointerLeave={() => setHovered(null)}>
        <defs>{[['download', '#399eff'], ['upload', '#9270ee']].map(([key, color]) => <linearGradient key={key} id={`${id}-${key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".2" /><stop offset="100%" stopColor={color} stopOpacity=".015" /></linearGradient>)}</defs>
        {[0, .5, 1].map((ratio) => <g key={ratio}><line className="chart-grid" x1="0" y1={height * ratio} x2={width} y2={height * ratio} /><text className="chart-y-label" x="-10" y={height * ratio + 4} textAnchor="end">{bytes(maximum * (1 - ratio))}</text></g>)}
        {['download', 'upload'].flatMap((direction) => smoothSegments(points, `${direction}Bytes`, width, height, maximum).map((segment, index) => <g key={`${direction}-${index}`}><path d={`${segment.path} L ${segment.lastX} ${height} L ${segment.firstX} ${height} Z`} fill={`url(#${id}-${direction})`} /><path className={`chart-line chart-${direction}`} d={segment.path} pathLength="1" /></g>))}
        {sampled.length > 0 && points.map((point, index) => point.observed && <g key={point.at}>{['download', 'upload'].map((direction) => <circle key={direction} className={`sample-dot ${direction}-point`} cx={coordinateX(index)} cy={height - point[`${direction}Bytes`] / maximum * height} r={hovered === index ? 4 : 2} />)}</g>)}
        {focus && <line className="chart-crosshair" x1={coordinateX(hovered)} x2={coordinateX(hovered)} y1="0" y2={height} />}
        {points.map((point, index) => <rect key={point.at} x={coordinateX(index) - width / Math.max(1, points.length - 1) / 2} y="0" width={width / Math.max(1, points.length - 1)} height={height} fill="transparent" onPointerEnter={() => setHovered(index)}><title>{label(point.at, data.unit)} · {point.observed ? `下载 ${bytes(point.downloadBytes)} / 上传 ${bytes(point.uploadBytes)}` : '无采样记录'}</title></rect>)}
        {tickIndices.map((index) => <text key={index} className="chart-x-label" x={coordinateX(index)} y={height + 29} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}>{label(points[index].at, data.unit)}</text>)}
      </svg>
      {!sampled.length && !error && <div className="chart-empty">{loading ? '正在读取流量…' : empty}</div>}
      {error && <div className="chart-error" role="alert"><span>流量读取失败：{error}</span><button className="secondary-button" onClick={() => setRefresh((value) => value + 1)}><RefreshCcw size={13} />重试</button></div>}
      <div className="chart-inspector" aria-live="polite">{focus ? <><span>{label(focus.at, data.unit)}</span>{focus.observed ? <><span className="download-text">下载 {bytes(focus.downloadBytes)}</span><span className="upload-text">上传 {bytes(focus.uploadBytes)}</span></> : <span>无采样记录</span>}</> : <span>{sampled.length ? '移动到曲线上查看分时用量' : '缺少采样的时段不会补画为零流量'}</span>}</div>
    </div>
    <div className="chart-footnote"><span>以用户视角统计上传 / 下载，时间按本地显示</span><span>{data?.lastSampleAt ? `最近采样 ${new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(data.lastSampleAt))}` : '等待采样'}</span></div>
  </section>;
}
