export function HeaderFields({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  let rows: [string, string][] = [];
  let valid = true;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every(item => Array.isArray(item) && item.length === 2 && item.every(field => typeof field === "string"))) valid = false;
    else rows = parsed;
  } catch { valid = false; }
  const update = (next: [string, string][]) => onChange(JSON.stringify(next, null, 2));
  return <div className="header-fields"><p>请求 Header（保留重复名称和顺序）</p>
    {valid ? <>{rows.map(([name, content], index) => <div className="header-field-row" key={index}>
      <input aria-label={`第${index + 1}个 Header 名称`} value={name} placeholder="Header 名称" onChange={event => update(rows.map((row, i) => i === index ? [event.target.value, row[1]] : row))} />
      <input aria-label={`第${index + 1}个 Header 值`} value={content} placeholder="值" onChange={event => update(rows.map((row, i) => i === index ? [row[0], event.target.value] : row))} />
      <button className="button ghost compact" onClick={() => update(rows.filter((_, i) => i !== index))}>移除</button>
    </div>)}<button className="button ghost compact" onClick={() => update([...rows, ["", ""]])}>添加 Header</button></> : <p role="alert">Header JSON 格式无效，请在高级编辑中修正；原输入已保留。</p>}
    <details><summary>高级 JSON 编辑</summary><textarea aria-label="请求头 JSON" rows={5} value={value} onChange={event => onChange(event.target.value)} /></details>
  </div>;
}
