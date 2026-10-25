export const agentCommands = [
  {name: "/compress", aliases: ["/compact"], label: "压缩历史", description: "本地压缩，不调用模型", idle: true},
  {name: "/new", aliases: [], label: "新建会话", description: "保留旧记录，开始新会话", idle: true},
  {name: "/help", aliases: [], label: "帮助", description: "打开功能说明", idle: false},
  {name: "/stop", aliases: [], label: "停止", description: "停止当前Agent任务", idle: false},
  {name: "/context", aliases: [], label: "上下文", description: "展开上下文与预算设置", idle: false},
  {name: "/sessions", aliases: [], label: "会话列表", description: "展开侧栏并定位会话", idle: false},
  {name: "/models", aliases: [], label: "模型与供应商", description: "选择已保存的供应商或管理配置", idle: false},
];
export function parseAgentCommand(text: string) {
  const value = text.trim();
  if (!value.startsWith("/") || value.startsWith("//")) return {kind: "text" as const, text: value.startsWith("//") ? value.slice(1) : value};
  const [name, ...args] = value.split(/\s+/);
  const command = agentCommands.find(item => item.name === name || item.aliases.includes(name));
  if (!command) return {kind: "error" as const, message: `未知命令 ${name}。输入 / 查看命令；普通斜杠文本请以 // 开头发送。`};
  if (args.length) return {kind: "error" as const, message: `${name} 不接受参数。若要将整段内容发给模型，请在开头再加一个 /。`};
  return {kind: "command" as const, command};
}
