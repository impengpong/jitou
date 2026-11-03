// BOSS 直聘薪资字体解码 — kanzhun-mix PUA 映射
// 解码公式：digit = codepoint - 0xE031
// 10 个字符 U+E031~U+E03A 一一对应 0~9
function decodeSalary(text) {
  if (!text) return '';
  let result = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    result += code >= 0xE031 && code <= 0xE03A ? String(code - 0xE031) : text[i];
  }
  return result;
}
