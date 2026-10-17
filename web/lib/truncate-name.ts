/** One ellipsis character for every clipped agent name (issue #383): never ".." next to "…". */
export function truncateName(name: string, max: number): string {
  return name.length > max ? name.slice(0, max) + '…' : name
}
