const QuizCpp = (() => {
  const nonCode = /(?:u8|[uUL])?R"([^ ()\\\t\r\n]{0,16})\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\\r\n])*"|(?<!\w)(?:u8|[uUL])?'(?:\\[\s\S]|[^'\\\r\n])*'|\/\/(?:\\\r?\n|[^\r\n])*|\/\*[\s\S]*?\*\/|^[ \t]*#(?:\\\r?\n|[^\r\n])*/gm;
  const mainDefinition = /\b(?:int|signed(?:\s+int)?|void|auto|int32_t)\s+main\s*\([^();{}]*\)\s*(?:noexcept\s*)?(?:->\s*int\s*)?\{/g;
  const declaration = /^(?:#|\b(?:using|typedef|template|class|struct|union|enum|namespace|extern|static|inline|constexpr|const|int|void|auto|bool|char|double|float|long|short|unsigned|signed)\b)/;

  function isCompleteProgram(source) {
    if (source.length > 65536 || new TextEncoder().encode(source).length > 65536) return false;
    const code = source.replace(nonCode, ' ');
    const definitions = new Set([...code.matchAll(mainDefinition)].map(match => match.index + match[0].length - 1));
    let depth = 0;
    let entryPoints = 0;
    for (let i = 0; i < code.length; i++) {
      if (code[i] === '{') {
        if (depth === 0 && definitions.has(i)) entryPoints++;
        depth++;
      } else if (code[i] === '}' && --depth < 0) {
        return false;
      }
    }
    return depth === 0 && entryPoints === 1;
  }

  function completePrograms(blocks) {
    const parts = blocks.filter(block => block.type === 'code' && block.content.trim()).map(block => block.content.trim());
    const individual = parts.filter(isCompleteProgram);
    if (individual.length > 1) return individual.slice(0, 20);
    const combined = (individual.length ? parts.filter(part => declaration.test(part) || part === individual[0]) : parts).join('\n\n');
    if (isCompleteProgram(combined)) return [combined];
    return individual;
  }

  return { isCompleteProgram, completePrograms };
})();

if (typeof module !== 'undefined') module.exports = QuizCpp;
