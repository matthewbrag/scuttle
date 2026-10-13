import Prism from "prismjs";
// Order matters — later ones extend earlier ones (tsx needs typescript needs javascript,
// cpp needs c, php needs markup-templating).
import "prismjs/components/prism-markup";
import "prismjs/components/prism-css";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-java";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-php";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-toml";

// A fence's language tag doesn't always match Prism's grammar name 1:1.
const LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  py: "python",
  py3: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  yml: "yaml",
  rb: "ruby",
  rs: "rust",
  golang: "go",
  html: "markup",
  xml: "markup",
  svg: "markup",
  "c++": "cpp",
  dockerfile: "docker",
};

/** Resolves a fence language to a grammar Prism actually has loaded, or undefined if
 * there's no match — callers should fall back to plain escaped text in that case. */
export function resolveLang(lang?: string): string | undefined {
  if (!lang) return undefined;
  const mapped = LANG_ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  return Prism.languages[mapped] ? mapped : undefined;
}

export function highlight(code: string, lang?: string): string {
  const resolved = resolveLang(lang);
  if (!resolved) return escapeHtml(code);
  return Prism.highlight(code, Prism.languages[resolved], resolved);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
