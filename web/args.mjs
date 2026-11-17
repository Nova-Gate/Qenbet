export function parseArguments(text) {
  const input = String(text ?? "");
  const args = [];
  let current = "";
  let started = false;
  let quote = null;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      if (character === quote) {
        quote = null;
        started = true;
        continue;
      }
      if (character === "\\" && quote === '"' && index + 1 < input.length) {
        const next = input[index + 1];
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          current += next;
          index += 1;
          continue;
        }
      }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === "\\") {
      if (index + 1 >= input.length) throw new Error("Trailing backslash.");
      current += input[index + 1];
      index += 1;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (quote) throw new Error("Unterminated quote.");
  if (started) args.push(current);
  return args;
}

export function formatArguments(args) {
  return (args ?? []).map((argument) => {
    const text = String(argument);
    if (text && !/[\s"'\\]/.test(text)) return text;
    return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }).join(" ");
}
