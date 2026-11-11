import type { GitHubUserResponse, UserContributions } from './types';
import { cacheGet, cacheSet } from './cache';

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

const CONTRIBUTIONS_QUERY = `
query($username: String!, $from: DateTime, $to: DateTime) {
  user(login: $username) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            date
            contributionCount
            color
          }
        }
      }
    }
  }
}`;

/** Cache past years for a day: their data no longer changes. */
export const PAST_YEAR_TTL = 24 * 60 * 60 * 1000;

/** Earliest year GitHub has contribution data for. */
export const MIN_YEAR = 2008;

export function isPastYear(year: number | undefined): boolean {
  return year !== undefined && year < new Date().getUTCFullYear();
}

/**
 * Fetch a user's contribution calendar.
 * Without `year`, returns the last year (GitHub's default view).
 * With `year`, returns Jan 1 – Dec 31 of that calendar year.
 */
export async function fetchContributions(
  username: string,
  token: string,
  year?: number
): Promise<UserContributions> {
  const cacheKey = `user:${username}:${year ?? 'last'}`;
  const cached = cacheGet<UserContributions>(cacheKey);
  if (cached) return cached;

  const response = await fetch(GITHUB_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'github-readme-contribution-merger',
    },
    body: JSON.stringify({
      query: CONTRIBUTIONS_QUERY,
      variables: {
        username,
        ...(year !== undefined && {
          from: `${year}-01-01T00:00:00Z`,
          to: `${year}-12-31T23:59:59Z`,
        }),
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as GitHubUserResponse;

  if (json.errors?.length) {
    throw new Error(`GitHub GraphQL error: ${json.errors[0].message}`);
  }

  if (!json.data.user) {
    throw new Error(`User "${username}" not found`);
  }

  const calendar = json.data.user.contributionsCollection.contributionCalendar;
  const days = calendar.weeks.flatMap((week) =>
    week.contributionDays.map((day) => ({
      date: day.date,
      count: day.contributionCount,
    }))
  );

  const result: UserContributions = {
    username,
    totalContributions: calendar.totalContributions,
    days,
  };

  cacheSet(cacheKey, result, isPastYear(year) ? PAST_YEAR_TTL : undefined);
  return result;
}

export interface FetchResult {
  fulfilled: UserContributions[];
  errors: Array<{ username: string; error: string }>;
}

export async function fetchMultipleUsers(
  usernames: string[],
  token: string,
  year?: number
): Promise<FetchResult> {
  const results = await Promise.allSettled(
    usernames.map((u) => fetchContributions(u, token, year))
  );

  const fulfilled: UserContributions[] = [];
  const errors: Array<{ username: string; error: string }> = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      fulfilled.push(result.value);
    } else {
      errors.push({
        username: usernames[i],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  return { fulfilled, errors };
}
