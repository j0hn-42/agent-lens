// #662: a domain module imported with the query of one language (locales/fr.ts, locales/en.ts). TypeScript does not
// resolve the query; the tables are checked by value instead (scripts/lazy-bundle.test.ts, scripts/messages.test.ts).
declare module '*?locale=fr' {
  export const fr: Readonly<Record<string, string>>
}
declare module '*?locale=en' {
  export const en: Readonly<Record<string, string>>
}
