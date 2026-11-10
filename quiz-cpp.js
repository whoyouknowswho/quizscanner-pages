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

  const compilerId = 'mingw64_ucrt_gcc_1130';
  const compilerLabel = 'MinGW GCC 11.3 · Windows 64-bit · GNU C++14';
  const compileUrl = 'https://godbolt.org/api/compiler/' + compilerId + '/compile';
  const windowsCrashes = {
    0xC0000005: 'Truy cập vùng nhớ không hợp lệ (access violation), thường do con trỏ null, con trỏ trỏ tới vùng đã giải phóng hoặc vượt chỉ số mảng.',
    0xC0000094: 'Chia số nguyên cho 0.',
    0xC0000095: 'Tràn số nguyên khi chia.',
    0xC000008E: 'Chia số thực cho 0.',
    0xC00000FD: 'Tràn ngăn xếp (stack overflow), thường do đệ quy không có điểm dừng.',
    0xC0000409: 'Chương trình bị dừng đột ngột (abort/terminate), thường do exception không được bắt.',
    0xC0000374: 'Vùng nhớ heap bị hỏng, thường do delete hai lần hoặc ghi ra ngoài vùng đã cấp phát.',
    0xC0000017: 'Không đủ bộ nhớ.',
    0xC000001D: 'Chương trình thực hiện lệnh không hợp lệ.',
    0x80000003: 'Chương trình dừng tại điểm ngắt (breakpoint).'
  };

  function compileRequest(code) {
    return {
      source: code,
      lang: 'c++',
      allowStoreCodeDebug: false,
      options: {
        userArguments: '-std=gnu++14 -O0 -fdiagnostics-color=never',
        executeParameters: { args: [], stdin: '' },
        compilerOptions: { executorRequest: true, skipAsm: true },
        filters: { execute: true },
        tools: [],
        libraries: []
      }
    };
  }

  function lines(list) {
    return (Array.isArray(list) ? list : [])
      .map(item => String(item?.text ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replaceAll('<source>', 'main.cpp'))
      .filter(text => text !== 'Killed - processing time exceeded')
      .join('\n')
      .replace(/^\n+|\s+$/g, '');
  }

  function hex(code) {
    return '0x' + (code >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }

  // Converts a Compiler Explorer response into what the run panel shows.
  function describeResult(result) {
    const build = result?.buildResult || {};
    const diagnostics = lines(build.stderr);
    const stdout = lines(result?.stdout);
    const stderr = lines(result?.stderr);
    const truncated = Boolean(result?.truncated || build.truncated);
    if (build.timedOut) {
      return { kind: 'compile', title: 'Lỗi biên dịch', detail: 'Biên dịch quá lâu nên bị dừng.', errors: diagnostics, stdout: '', stderr: '', truncated };
    }
    if (!result?.didExecute) {
      if (build.code !== 0 && build.code !== undefined) {
        return { kind: 'compile', title: 'Lỗi biên dịch', detail: 'Chương trình chưa biên dịch được nên không chạy.', errors: diagnostics || stderr, stdout: '', stderr: '', truncated };
      }
      return { kind: 'failed', title: 'Không chạy được chương trình', detail: stderr || 'Máy chủ biên dịch không chạy chương trình.', errors: diagnostics, stdout: '', stderr: '', truncated };
    }
    const base = { warnings: diagnostics, stdout, stderr, truncated, execTime: Number(result.execTime) || 0 };
    if (result.timedOut) {
      return { ...base, kind: 'timeout', title: 'Quá thời gian chạy', detail: 'Chương trình chạy quá lâu nên bị dừng, có thể do vòng lặp vô hạn hoặc đang chờ nhập dữ liệu.' };
    }
    const code = Number(result.code);
    if (code === 0) return { ...base, kind: 'ok', title: 'Chạy thành công', detail: 'Mã thoát 0' };
    const unsigned = code >>> 0;
    if (windowsCrashes[unsigned] || unsigned >= 0xC0000000) {
      return { ...base, kind: 'runtime', title: 'Lỗi khi chạy (runtime error)', detail: (windowsCrashes[unsigned] || 'Chương trình bị Windows dừng do lỗi.') + ' Mã lỗi ' + hex(unsigned) + '.' };
    }
    return { ...base, kind: 'exit', title: 'Chương trình kết thúc với mã thoát ' + code, detail: 'main trả về hoặc gọi exit với giá trị khác 0.' };
  }

  async function runProgram(code, { signal, fetchImpl = fetch } = {}) {
    let response;
    try {
      response = await fetchImpl(compileUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(compileRequest(code)),
        signal
      });
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
      return { kind: 'network', title: 'Không kết nối được máy chủ biên dịch', detail: 'Kiểm tra kết nối mạng rồi bấm Chạy lại.' };
    }
    if (!response.ok) {
      const detail = response.status === 429 ? 'Máy chủ biên dịch đang giới hạn số lần chạy. Chờ vài giây rồi bấm Chạy lại.'
        : 'Máy chủ biên dịch trả về lỗi ' + response.status + '. Bấm Chạy lại sau ít phút.';
      return { kind: 'network', title: 'Máy chủ biên dịch chưa phản hồi', detail };
    }
    return describeResult(await response.json());
  }

  return { isCompleteProgram, completePrograms, compileRequest, describeResult, runProgram, compilerLabel };
})();

if (typeof module !== 'undefined') module.exports = QuizCpp;
