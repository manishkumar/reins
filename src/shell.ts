/**
 * Just enough shell reading to find which commands a Bash call ran. Used by
 * the claim check and the footprint, on the captured one-line summary.
 *
 * Not a parser. It strips quoted text and heredoc bodies (data, not commands),
 * splits on `&&`, `||`, `;` and `&`, and looks at the first stage of each
 * pipeline. It reads through `sh -c "…"`, a subshell's parentheses, and the
 * keywords of an `if` or a loop, because the command inside them still ran.
 * When it cannot tell, it returns less: both callers prefer missing a command
 * to inventing one.
 */

export interface ShellCommand {
  /** The command's words, with env assignments and wrappers like `npx` removed. */
  words: string[];
  /** True when its output is piped onward, so the exit status is another command's. */
  piped: boolean;
  /** What joins it to the next command, or null when it is the last one. `&` is a background job. */
  then: "&&" | "||" | ";" | "&" | null;
}

/** Words allowed in front of the command itself. */
const PREFIX =
  /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|[({]|if|then|else|elif|do|while|until|time|command|exec|sudo|env|nice(?:\s+-n\s*-?\d+)?|nohup|timeout(?:\s+-[sk]\s+\S+|\s+-\S+)*\s+[\d.]+[smhd]?|npx|bunx|pnpx|pnpm\s+exec|pnpm\s+dlx|yarn\s+dlx|bundle\s+exec|poetry\s+run|uv\s+run|pipenv\s+run)\s+)*/;

export function shellCommands(command: string): ShellCommand[] {
  let s = command;
  const heredoc = s.indexOf("<<");
  if (heredoc >= 0) s = s.slice(0, heredoc);
  // `sh -c "npm test"` runs what is in the quotes.
  s = s.replace(/(?:^|(?<=[\s;&|(]))(?:ba|z|da)?sh\s+(?:-[a-z]+\s+)*-[a-z]*c\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g, (_, single, double) => ` ${single ?? double} `);
  // Quoted text can hold any character, including the separators below.
  s = s.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, " Q ");
  // An unclosed quote: the rest is inside it (or the summary was cut there).
  const open = s.search(/['"]/);
  if (open >= 0) s = s.slice(0, open);

  const out: ShellCommand[] = [];
  // A lone `&` is a separator. `&&`, `>&`, `&>` and `2>&1` are not.
  const parts = s.split(/(&&|\|\||;|(?<![>&])&(?![>&]))/);
  for (let i = 0; i < parts.length; i += 2) {
    const stages = parts[i].split("|");
    const words = stages[0]
      .trim()
      .replace(PREFIX, "")
      .split(/\s+/)
      .filter((w) => w && !/^[)}]+$/.test(w))
      .map((w) => w.replace(/[)}]+$/, ""));
    if (!words.length) continue;
    out.push({ words, piped: stages.length > 1, then: (parts[i + 1] as ShellCommand["then"]) ?? null });
  }
  // A separator with nothing after it (`npm test;`, a closing `fi`) joins to nothing.
  const lastCmd = out[out.length - 1];
  if (lastCmd && lastCmd.then !== "&") lastCmd.then = null;
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
