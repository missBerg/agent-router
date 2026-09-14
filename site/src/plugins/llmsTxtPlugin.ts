import type { LoadContext, Plugin } from '@docusaurus/types';
import type { DocMetadata, LoadedContent, LoadedVersion } from '@docusaurus/plugin-content-docs';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';

/**
 * Writes /llms.txt (section index) and /llms-full.txt (concatenated content),
 * per https://llmstxt.org, from the docs version Docusaurus serves at /docs/
 * (`lastVersion`, currently 1.1). `next` and the unmaintained versions are
 * never included. Runs in postBuild so it can reuse the docs plugin's loaded
 * metadata (permalinks, titles, sidebar order) instead of guessing URLs.
 */

const TITLE = 'Agent Router (formerly Envoy AI Gateway)';
const DESCRIPTION =
  'The open source AI gateway and MCP gateway built on Envoy and Envoy Gateway. An Agentic AI Foundation project. Agent Router controls; Envoy carries.';
const INTRO =
  'Agent Router gives application teams one OpenAI-compatible API for every model and MCP tool, and platform teams one place to enforce credentials, routing, quotas, failover and usage attribution. Repository: https://github.com/theagentrouter/agent-router · License: Apache-2.0';

type Sidebar = LoadedVersion['sidebars'][string];
type Entry = { section: string; doc: DocMetadata };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Docs in sidebar (navigation) order; the top-level sidebar item names the section. */
function orderedDocs(version: LoadedVersion): Entry[] {
  const byId = new Map(version.docs.map((d) => [d.id, d]));
  const out: Entry[] = [];
  const add = (id: string, section?: string) => {
    const doc = byId.get(id);
    if (doc && !doc.draft && !doc.unlisted) out.push({ section: section ?? doc.title, doc });
  };
  const walk = (items: Sidebar, section?: string) => {
    for (const item of items) {
      if (item.type === 'doc') add(item.id, section);
      else if (item.type === 'category') {
        const label = section ?? item.label;
        if (item.link?.type === 'doc') add(item.link.id, label);
        walk(item.items, label);
      }
    }
  };
  Object.values(version.sidebars).forEach((sidebar) => walk(sidebar));
  return out;
}

/** Prose-only cleanup (never applied inside fenced code blocks). */
function cleanProse(s: string): string {
  return s
    .replace(/^import\s.*$/gm, '')
    .replace(/<!--[\s\S]*?-->|\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<\/?code>/g, '`')
    .replace(/<a\s+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)')
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/g, '$1')
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<\/?div\b[^>]*>/g, '')
    .replace(/^:::(\w+)(?:\[([^\]]*)\]|[ \t]+(.+?))?[ \t]*$/gm, (_, kind: string, t1?: string, t2?: string) => `**${t1 ?? t2 ?? cap(kind)}:**`)
    .replace(/^:::[ \t]*$/gm, '')
    .replace(/<TabItem\b[^>]*\blabel="([^"]*)"[^>]*>/g, '**$1**')
    .replace(/<\/?[A-Z][A-Za-z]*\b[^>]*>/g, '');
}

/** MDX source -> plain Markdown: resolve `${vars.x}`, flatten JSX, drop admonition fences. */
function toMarkdown(file: string): string {
  const raw = matter(fs.readFileSync(file, 'utf-8')).content;
  // `import vars from '../_vars.json'` feeds ${vars.x} inside template literals.
  const varsImport = raw.match(/^import vars from '([^']+)'/m);
  const vars: Record<string, string> = varsImport
    ? JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), varsImport[1].replace(/\\/g, '')), 'utf-8'))
    : {};
  const unescape = (s: string) => s.replace(/\\\\/g, '\\'); // template-literal escapes
  const attr = (attrs: string, k: string) => attrs.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1] ?? '';
  return raw
    .replace(/\$?\{vars\.(\w+)\}/g, (_, k: string) => String(vars[k] ?? ''))
    // <ApiField name type required description /> -> a list item. Runs before the
    // fence split because generated descriptions may embed ``` examples.
    .replace(/<ApiField\b((?:\s+\w+="[^"]*")*)\s*\/>/g, (_, a: string) => {
      const required = attr(a, 'required') === 'true' ? ', required' : '';
      const description = attr(a, 'description').replace(/<br\s*\/?>/g, '\n  ');
      return `\n- **${attr(a, 'name')}** (${attr(a, 'type')}${required}): ${description}\n`;
    })
    .replace(/<CodeBlock(?:\s+language="([^"]*)")?>\s*\{`([\s\S]*?)`\}\s*<\/CodeBlock>/g, (_, lang = '', code: string) => `\`\`\`${lang}\n${unescape(code)}\n\`\`\``)
    .replace(/<Link\b[^>]*>\s*\{`([^`]*)`\}\s*<\/Link>/g, (_, text: string) => unescape(text))
    .split(/(```[\s\S]*?```)/)
    // Odd segments are fenced code and pass through verbatim. The page H1 in
    // the first prose segment duplicates the title we emit ourselves.
    .map((seg, i) => (i % 2 ? seg : i === 0 ? cleanProse(seg).replace(/^# .*\n/m, '') : cleanProse(seg)))
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** First real paragraph, collapsed to one line and (roughly) one sentence. */
function summarize(md: string): string {
  const para = md
    .replace(/```[\s\S]*?```/g, '')
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .find((p) => p && !/^([#>|!<:*-]|\d+\.)/.test(p));
  const text = (para ?? '')
    .replace(/\s+/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/:$/, '.');
  const sentence = text.match(/^.{20,}?[.!?](?=\s|$)/)?.[0] ?? text;
  return sentence.length > 200 ? `${sentence.slice(0, 197).trimEnd()}…` : sentence;
}

export default function llmsTxtPlugin(context: LoadContext): Plugin {
  return {
    name: 'docusaurus-plugin-llms-txt',

    async postBuild({ plugins, outDir }) {
      const docsPlugin = plugins.find((p) => p.name === 'docusaurus-plugin-content-docs' && p.options.id === 'default');
      const version = (docsPlugin?.content as LoadedContent | undefined)?.loadedVersions.find((v) => v.isLast);
      if (!version) throw new Error('[llms-txt] could not find the docs version served at /docs/');

      const base = context.siteConfig.url.replace(/\/$/, '');
      const header = `# ${TITLE}\n\n> ${DESCRIPTION}\n\n${INTRO}\n`;
      const sections = new Map<string, string[]>();
      const full: string[] = [];
      for (const { section, doc } of orderedDocs(version)) {
        const url = base + doc.permalink;
        const md = toMarkdown(path.join(context.siteDir, doc.source.replace(/^@site\//, '')));
        sections.set(section, [...(sections.get(section) ?? []), `- [${doc.title}](${url}): ${summarize(md)}`]);
        full.push(`\n---\n\n# ${doc.title}\n\nSource: ${url}\n\n${md}\n`);
      }
      const index = [...sections].map(([label, items]) => `\n## ${label}\n\n${items.join('\n')}\n`).join('');
      fs.writeFileSync(path.join(outDir, 'llms.txt'), header + index);
      fs.writeFileSync(path.join(outDir, 'llms-full.txt'), header + full.join(''));
      console.log(`[llms-txt] wrote llms.txt (${sections.size} sections, ${full.length} pages) and llms-full.txt from docs version ${version.versionName}`);
    },
  };
}
