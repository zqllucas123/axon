/** Markdown → 纯文本。去掉语法标记，保留可读内容。 */
export async function ingestMd(content: string, sourceRef: string): Promise<{ title: string; pageContent: string }[]> {
  // 提取第一个 # 标题作为 title
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch?.[1]?.trim() ?? (sourceRef.split('/').pop() ?? sourceRef);

  // 移除 Markdown 语法：代码块、内联代码、链接、图片、粗体/斜体、水平线、HTML 标签
  let text = content
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[^\n]*/g, '').trim()) // 代码块保留内容
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))                           // 内联代码
    .replace(/!\[.*?\]\(.*?\)/g, '')                                        // 图片
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')                               // 链接 → 文字
    .replace(/^#{1,6}\s+/gm, '')                                            // 标题符号
    .replace(/(\*\*|__)(.*?)\1/g, '$2')                                     // 粗体
    .replace(/(\*|_)(.*?)\1/g, '$2')                                        // 斜体
    .replace(/^[-*+]\s+/gm, '')                                             // 无序列表
    .replace(/^\d+\.\s+/gm, '')                                             // 有序列表
    .replace(/^>\s+/gm, '')                                                 // 引用
    .replace(/^[-*_]{3,}$/gm, '')                                           // 水平线
    .replace(/<[^>]+>/g, '')                                                // HTML 标签
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return [{ title, pageContent: text }];
}
