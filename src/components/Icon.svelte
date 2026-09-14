<script lang="ts">
  const PATHS: Record<string, string> = {
    search: 'M10.5 3.5a7 7 0 1 1 0 14 7 7 0 0 1 0-14ZM15.5 15.5 21 21',
    undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
    redo: 'm15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
    dots: 'M5 12h.01M12 12h.01M19 12h.01',
    close: 'M6 6l12 12M18 6 6 18',
    minimize: 'M5 12h14',
    maximize: 'M6 6h12v12H6z',
    restore: 'M8 8h11v11H8zM5 15V5h10',
    plus: 'M12 5v14M5 12h14',
    check: 'm5 12 5 5L20 7',
    chevronDown: 'm6 9 6 6 6-6',
    chevronUp: 'm6 15 6-6 6 6',
    arrowUp: 'M12 19V5m-7 7 7-7 7 7',
    arrowDown: 'M12 5v14m7-7-7 7-7-7',
    filter: 'M4 5h16l-6 8v6l-4-2v-4L4 5Z',
    replace: 'M4 7h11l-3-3M20 17H9l3 3',
    caseSensitive: 'M3 17 7.5 6l4.5 11M4.5 13h6M14 17v-7m0 4.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0M19 10v7',
    file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5',
    sortAsc: 'M4 6h9M4 12h6M4 18h4M17 20V8m-4 4 4-4 4 4',
    sortDesc: 'M4 6h9M4 12h6M4 18h4M17 4v12m-4-4 4 4 4-4',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    columns: 'M4 5h16v14H4zM10 5v14M15 5v14',
    rows: 'M4 5h16v14H4zM4 10h16M4 15h16',
    keyboard: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M7 14h10',
    palette: 'm7 8 4 4-4 4M13 16h4',
    sun: 'M12 4v2m0 12v2M4 12h2m12 0h2M6.3 6.3l1.4 1.4m8.6 8.6 1.4 1.4M6.3 17.7l1.4-1.4m8.6-8.6 1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z',
    moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
    monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
    type: 'M5 6V4h14v2M12 4v16M9 20h6',
    grid: 'M4 4h16v16H4zM4 10h16M4 15h16M10 4v16M15 4v16',
    folder: 'M3 6h6l2 2h10v11H3z',
    hash: 'M5 9h14M5 15h14M10 4 8 20M16 4l-2 16',
    warning: 'M12 4 2 20h20L12 4Zm0 6v5m0 3h.01',
  };
  let { name, size = 16 }: { name: string; size?: number } = $props();
  let d = $derived(PATHS[name] ?? '');
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path {d} />
</svg>
