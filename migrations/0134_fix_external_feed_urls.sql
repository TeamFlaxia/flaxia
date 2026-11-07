-- Fix external feed URLs. The original arXiv query `all:*` makes the arXiv
-- API return HTTP 500 with an <entry><title>Error</title> body, so arXiv
-- never ingests. `cat:*` returns HTTP 200 with the latest submissions across
-- all categories. Also widen the page size from 50 to 200 per refresh so
-- hourly refreshes accumulate a fuller timeline (upserts keep prior items;
-- only >30 days are pruned).

UPDATE external_sources
SET feed_url = 'https://export.arxiv.org/api/query?search_query=cat:%2A&sortBy=submittedDate&sortOrder=descending&max_results=200'
WHERE source = 'arxiv';

UPDATE external_sources
SET feed_url = 'https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=200'
WHERE source = 'hackernews';
