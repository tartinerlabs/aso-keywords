import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  smallint,
  snakeCase,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

// One App Store search result as stored on a check; ratings are per storefront.
export type TopApp = {
  id: number;
  name: string;
  icon: string;
  ratings: number;
  avg: number;
};

export const keywords = snakeCase.table(
  "keywords",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    phrase: text().notNull(),
    country: varchar({ length: 2 }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex().on(t.country, t.phrase),
    check("keywords_country_ck", sql`${t.country} ~ '^[a-z]{2}$'`),
  ],
);

export const keywordChecks = snakeCase.table(
  "keyword_checks",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    keywordId: integer()
      .notNull()
      .references(() => keywords.id, { onDelete: "cascade" }),
    checkedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    volume: smallint().notNull(),
    difficulty: smallint().notNull(),
    // Search results in rank order (index 0 = rank 1)
    topApps: jsonb().$type<TopApp[]>().notNull(),
    appId: bigint({ mode: "number" }),
    rank: smallint(),
  },
  (t) => [
    index().on(t.keywordId, t.checkedAt.desc()),
    check("keyword_checks_volume_ck", sql`${t.volume} between 0 and 100`),
    check(
      "keyword_checks_difficulty_ck",
      sql`${t.difficulty} between 0 and 100`,
    ),
  ],
);
