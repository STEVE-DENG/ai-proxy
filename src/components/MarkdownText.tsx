import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MarkdownText({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ children, href }) => <span className="markdown-link" title={href}>{children}{href && <small> ({href})</small>}</span>,
    img: ({ alt }) => <span>[图片：{alt || "未加载"}]</span>,
  }}>{text}</ReactMarkdown>;
}
