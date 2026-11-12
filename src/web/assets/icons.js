// One centered 24-unit outline family, shared by server markup and canvas glyphs.
export const ICON_PATHS = Object.freeze({
  organization:
    "M-8 9V-7L0-10 8-7V9M-4-4h1m6 0h1M-4 0h1m6 0h1M-2 9V4h4v5M-10 9h20",
  business_unit: "M-8-9H8V-3H-8ZM-8 3H-2V9H-8ZM2 3H8V9H2ZM0-3V0M-5 3V0H5V3",
  project: "M-9-5H-2L0-8H9V8H-9Z",
  repository:
    "M-7 7V-7a2 2 0 0 1 2-2H7V5H-5a2 2 0 0 0-2 2 2 2 0 0 0 2 2H7V5M-2-9V-3l1.5-1.2L1-3V-9",
  network:
    "M-2-7a2 2 0 1 0 4 0 2 2 0 1 0-4 0M-9 6a2 2 0 1 0 4 0 2 2 0 1 0-4 0M5 6a2 2 0 1 0 4 0 2 2 0 1 0-4 0M-1-5-6 4M1-5 6 4M-5 6H5",
  review: "M-5-9H5L8-6V9H-8V-6ZM-4 0-1 3 5-3",
  system:
    "M-3 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0M0-9V-7M0 7V9M-9 0H-7M7 0H9M-6-6-5-5M5 5 6 6M-6 6-5 5M5-5 6-6",
  agent: "M-7-5H7V7H-7ZM0-9V-5M-10 0H-7M7 0H10M-3-1v1M3-1v1M-3 4H3",
  skill: "M1-9-6 2H0L-1 9 6-2H0Z",
  instruction: "M-7-7H7M-7 0H7M-7 7H3",
  rule: "M0-9 7-6V0C7 5 3 8 0 10-3 8-7 5-7 0V-6Z",
  memory: "M-8-8H8V8H-8ZM-4-4H4M-4 0H4M-4 4H1",
  source:
    "M-7.2-6a2.2 2.2 0 1 0 4.4 0 2.2 2.2 0 1 0-4.4 0M-7.2 6a2.2 2.2 0 1 0 4.4 0 2.2 2.2 0 1 0-4.4 0M-5-3.8V3.8M2.8 6a2.2 2.2 0 1 0 4.4 0 2.2 2.2 0 1 0-4.4 0M5 3.8V-1.5a3.5 3.5 0 0 0-3.5-3.5H-1.5M1-7.5-1.5-5 1-2.5",
  commit: "M-10 0H-4M4 0H10M-4 0a4 4 0 1 0 8 0 4 4 0 1 0-8 0",
  issue:
    "M-8 0a8 8 0 1 0 16 0 8 8 0 1 0-16 0M-1.6 0a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0",
  document: "M-6-9H2L7-4V9H-6ZM2-9V-4H7M-2 0H3M-2 4H3",
  person: "M-4-5a4 4 0 1 0 8 0 4 4 0 1 0-8 0M-8 9V7a8 8 0 0 1 16 0V9",
  agent_account: "M-7-4a4 4 0 1 0 8 0 4 4 0 1 0-8 0M0-1 9 8M5 4 7 2M7 6 9 4",
  plus: "M-7 0H7M0-7V7",
  minus: "M-7 0H7",
  fit: "M-8-3V-8H-3M3-8H8V-3M8 3V8H3M-3 8H-8V3",
  expand: "M2-9H9V-2M9-9 2-2M-2 9H-9V2M-9 9-2 2",
  back: "M8 0H-8M-2-6-8 0-2 6",
  forward: "M-8 0H8M2-6 8 0 2 6",
});
export const ICON_GLYPHS = Object.freeze(
  Object.fromEntries(
    Object.entries(ICON_PATHS).map(([name, stroke]) => [name, { stroke }]),
  ),
);
