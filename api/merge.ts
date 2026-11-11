import type { MergeMode } from '../src/types';
import { fetchMultipleUsers, isPastYear, MIN_YEAR } from '../src/github';
import { mergeContributions } from '../src/merger';
import { renderSvg, renderErrorSvg } from '../src/svg';
import { cacheGet, cacheSet } from '../src/cache';
import { THEME_NAMES, DEFAULT_CUSTOM_COLORS, buildCustomTheme, generateLevels } from '../src/themes';

const USERNAME_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const HEX_COLOR_REGEX = /^[0-9a-fA-F]{6}$/;
const MAX_USERS = 10;
const VALID_MODES: MergeMode[] = ['sum', 'overlay'];

export interface ApiRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
}

export interface ApiResponse {
  setHeader(name: string, value: string): void;
  status(code: number): ApiResponse;
  send(body: string): void;
}

function parseUsernames(req: ApiRequest): string[] {
  const usernames: string[] = [];

  // Check `users` param (comma-separated)
  const usersParam = req.query.users;
  if (usersParam) {
    const raw = Array.isArray(usersParam) ? usersParam[0] : usersParam;
    usernames.push(...raw.split(',').map((u) => u.trim()).filter(Boolean));
  }

  // Check `user1`, `user2`, etc.
  for (let i = 1; i <= MAX_USERS; i++) {
    const param = req.query[`user${i}`];
    if (param) {
      const raw = Array.isArray(param) ? param[0] : param;
      const trimmed = raw.trim();
      if (trimmed) usernames.push(trimmed);
    }
  }

  // Deduplicate while preserving order
  return [...new Set(usernames)];
}

function respondSvg(
  res: ApiResponse,
  svg: string,
  status: number = 200,
  failedUsers?: string[],
  maxAge: number = 300
): void {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', status === 200
    ? `public, max-age=${maxAge}, s-maxage=${maxAge}`
    : 'no-cache'
  );
  if (failedUsers && failedUsers.length > 0) {
    res.setHeader('X-Failed-Users', failedUsers.join(','));
    res.setHeader('Access-Control-Expose-Headers', 'X-Failed-Users');
  }
  res.status(status).send(svg);
}

function buildTitle(total: number, year?: number): string {
  const noun = total === 1 ? 'contribution' : 'contributions';
  const period = year === undefined ? 'the last year' : String(year);
  return `${total.toLocaleString('en-US')} ${noun} in ${period}`;
}

export default async function handler(
  req: ApiRequest,
  res: ApiResponse
): Promise<void> {
  if (req.method !== 'GET') {
    respondSvg(res, renderErrorSvg('Method not allowed. Use GET.'), 405);
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    respondSvg(res, renderErrorSvg('Server misconfigured: GITHUB_TOKEN not set.'), 500);
    return;
  }

  // Parse usernames
  const usernames = parseUsernames(req);
  if (usernames.length < 1) {
    respondSvg(
      res,
      renderErrorSvg('At least 1 username is required.'),
      400
    );
    return;
  }
  if (usernames.length > MAX_USERS) {
    respondSvg(res, renderErrorSvg(`Maximum ${MAX_USERS} users allowed.`), 400);
    return;
  }

  // Validate username format
  for (const username of usernames) {
    if (!USERNAME_REGEX.test(username) || username.length > 39) {
      respondSvg(res, renderErrorSvg(`Invalid GitHub username: "${username}"`), 400);
      return;
    }
  }

  // Parse mode
  const modeParam = Array.isArray(req.query.mode) ? req.query.mode[0] : req.query.mode;
  const mode: MergeMode = VALID_MODES.includes(modeParam as MergeMode)
    ? (modeParam as MergeMode)
    : 'sum';

  // Parse year (omitted = last year, like GitHub's default view)
  const yearParam = Array.isArray(req.query.year) ? req.query.year[0] : req.query.year;
  let year: number | undefined;
  if (yearParam !== undefined && yearParam !== '') {
    const currentYear = new Date().getUTCFullYear();
    year = Number(yearParam);
    if (!/^\d{4}$/.test(yearParam) || year < MIN_YEAR || year > currentYear) {
      respondSvg(res, renderErrorSvg(`Invalid year: "${yearParam}". Use ${MIN_YEAR}-${currentYear}.`), 400);
      return;
    }
  }
  // Past years never change, so let browsers, camo and the CDN keep them for a day.
  const maxAge = isPastYear(year) ? 86400 : 300;

  // Parse custom colors
  const colorsParam = Array.isArray(req.query.colors) ? req.query.colors[0] : req.query.colors;
  const bgParam = Array.isArray(req.query.bg) ? req.query.bg[0] : req.query.bg;
  const isDark = bgParam !== 'light';

  let customColors: string[] | undefined;
  if (colorsParam) {
    const rawColors = colorsParam.split(',').map((c) => c.trim()).filter(Boolean);
    for (const color of rawColors) {
      if (!HEX_COLOR_REGEX.test(color)) {
        respondSvg(res, renderErrorSvg(`Invalid hex color: "${color}". Use 6-char hex without #.`), 400);
        return;
      }
    }
    customColors = rawColors;
  }

  // Parse theme — in overlay mode, only dark themes are allowed
  const themeParam = Array.isArray(req.query.theme) ? req.query.theme[0] : req.query.theme;
  const OVERLAY_THEMES = ['github', 'github-dark', 'blue-dark', 'purple-dark', 'orange-dark'];
  const allowedThemes = mode === 'overlay' ? OVERLAY_THEMES : THEME_NAMES;
  const theme = allowedThemes.includes(themeParam ?? '') ? themeParam! : 'github';

  // Check SVG cache (include colors and bg in key)
  const svgCacheKey = `svg:${usernames.join(',')}:${mode}:${theme}:${customColors?.join(',') ?? ''}:${bgParam ?? ''}:${year ?? 'last'}`;
  const cached = cacheGet<{ svg: string; failedUsers: string[] }>(svgCacheKey);
  if (cached) {
    respondSvg(res, cached.svg, 200, cached.failedUsers, cached.failedUsers.length > 0 ? 300 : maxAge);
    return;
  }

  // Fetch contributions
  const { fulfilled, errors } = await fetchMultipleUsers(usernames, token, year);

  if (fulfilled.length === 0) {
    const errorMessages = errors.map((e) => `${e.username}: ${e.error}`).join('; ');
    respondSvg(res, renderErrorSvg(`Failed to fetch all users. ${errorMessages}`), 502);
    return;
  }

  // Build render options
  const fulfilledUsernames = fulfilled.map((u) => u.username);
  const failedUsernames = errors.map((e) => e.username);
  const renderOptions: import('../src/types').RenderOptions = {
    mode,
    theme,
    usernames: fulfilledUsernames,
    failedUsers: failedUsernames.length > 0 ? failedUsernames : undefined,
    title: buildTitle(fulfilled.reduce((sum, u) => sum + u.totalContributions, 0), year),
  };

  if (customColors) {
    // Auto-fill missing colors from default palette
    const allColors = [...customColors];
    for (let i = allColors.length; i < fulfilledUsernames.length; i++) {
      allColors.push(DEFAULT_CUSTOM_COLORS[i % DEFAULT_CUSTOM_COLORS.length]);
    }

    // Build custom theme for background/text/empty/border
    renderOptions.customTheme = buildCustomTheme(allColors[0], isDark);

    if (mode === 'overlay') {
      // Each user gets their own palette
      renderOptions.customPalettes = fulfilledUsernames.map((_, i) => ({
        levels: generateLevels(allColors[i], isDark),
      }));
    } else {
      // Sum mode: first color's levels
      renderOptions.customTheme.levels = generateLevels(allColors[0], isDark);
    }
  }

  // Merge and render
  const merged = mergeContributions(fulfilled);
  const svg = renderSvg(merged, renderOptions);

  // Don't keep partial results (some users failed) for a whole day.
  const effectiveMaxAge = failedUsernames.length > 0 ? 300 : maxAge;
  cacheSet(svgCacheKey, { svg, failedUsers: failedUsernames }, effectiveMaxAge * 1000);
  respondSvg(res, svg, 200, failedUsernames, effectiveMaxAge);
}
