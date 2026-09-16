import { useState } from "react";
import { dismissMapGuide, shouldShowMapGuide, type StorageLike } from "./clarity.ts";

export function FirstUseNotice({ storage = localStorage, forceVisible = false, onDismiss }: { storage?: StorageLike; forceVisible?: boolean; onDismiss?: () => void }) {
  const [visible, setVisible] = useState(() => forceVisible || shouldShowMapGuide(storage));
  if (!visible) return null;
  return <aside className="first-use-notice" role="note" aria-label="Map guide">
    <strong>How to read this map</strong>
    <p>Sessions are the main work containers. Expand one to see its ordered Turns and follow a branch to a related Session.</p>
    <p>Codex history stays read-only. AI organization is a suggestion; your edits take precedence and can be restored later.</p>
    <button type="button" onClick={() => { dismissMapGuide(storage); setVisible(false); onDismiss?.(); }}>Got it</button>
  </aside>;
}
