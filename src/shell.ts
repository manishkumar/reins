/**
 * Just enough shell reading to find which commands a Bash call ran. Used by
 * the claim check and the footprint, on the captured one-line summary.
 *
 * Not a parser. It strips quoted text and heredoc bodies (data, not commands),
 * splits on `&&`, `||` and `;`, and looks at the first stage of each pipeline.
 * When it cannot tell, it returns less: both callers prefer missing a command
 * to inventing one.
 */

export interface ShellCommand {
  /** The command's words, with env assignments and wrappers like `npx` removed. */
  words: string[];
  /** True when its output is piped onward, so the exit status is another command's. */
  piped: boolean;
}

/** Words allowed in front of the command itself. */
const PREFIX =
  /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|time|command|exec|sudo|npx|bunx|pnpx|pnpm\s+exec|pnpm\s+dlx|yarn\s+dlx|bundle\s+exec|poetry\s+run|uv\s+run|pipenv\s+run)\s+)*/;

export function shellCommands(command: string): ShellCommand[] {
  let s = command;
  const heredoc = s.indexOf("<<");
  if (heredoc >= 0) s = s.slice(0, heredoc);
  // Quoted text can hold any character, including the separators below.
  s = s.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, " Q ");
  // An unclosed quote: the rest is inside it (or the summary was cut there).
  const open = s.search(/['"]/);
  if (open >= 0) s = s.slice(0, open);

  const out: ShellCommand[] = [];
  for (const pipeline of s.split(/&&|\|\||;/)) {
    const stages = pipeline.split("|");
    const words = stages[0].trim().replace(PREFIX, "").split(/\s+/).filter(Boolean);
    if (words.length) out.push({ words, piped: stages.length > 1 });
  }
  return out;
}

/**
 * True for a shell line that can change files without an edit tool: a
 * redirect into a file, an in-place sed or perl, tee, or an inline script.
 * Such changes are not in the footprint, so the count of these lines is.
 */
export function mayWriteFiles(command: string): boolean {
  if (/<<-?\s*['"]?\w+/.test(command) && /^\s*(\S+=\S*\s+)*(python[\d.]*|node|ruby|perl|bash|sh|zsh)\b/.test(command)) return true;
  if (/(^|[^0-9&>])>{1,2}\s*(?!\/dev\/null|&)[^\s>&]/.test(command.replace(/<<-?\s*['"]?\w+['"]?/g, ""))) return true;
  if (/\|\s*tee\s+(?!\/dev\/null)/.test(command)) return true;
  return shellCommands(command).some(({ words }) => {
    const text = words.join(" ");
    return /^(sed|perl)\s+(\S+\s+)*-\w*i/.test(text) || /^(tee|patch)\b/.test(text) || /^git\s+(apply|checkout|restore|stash|reset|merge|rebase|cherry-pick|pull)\b/.test(text);
  });
}
