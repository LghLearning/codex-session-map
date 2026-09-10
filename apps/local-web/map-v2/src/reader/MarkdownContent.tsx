import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownContent({ value }: { value?: string }) {
  if (!value) return <p className="reader-empty">No content recorded.</p>;
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>,
    table: ({ children, ...props }) => <div className="markdown-table"><table {...props}>{children}</table></div>,
    pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  }}>{value}</ReactMarkdown>;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const text = textContent(children);
  return <div className="markdown-code"><button type="button" onClick={() => void navigator.clipboard.writeText(text)}>Copy</button><pre>{children}</pre></div>;
}
function textContent(value: ReactNode): string {
  return Children.toArray(value).map((item) => typeof item === "string" || typeof item === "number" ? String(item) : isValidElement<{ children?: ReactNode }>(item) ? textContent(item.props.children) : "").join("");
}
