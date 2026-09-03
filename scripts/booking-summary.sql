-- PII-safe summary of the production BookingRequest table.
-- Deliberately returns NO names, phones or notes — only shape and volume, so the
-- output is safe to paste. Inspect actual rows yourself if the counts warrant it.
SELECT 'rows: '            || count(*)                                   FROM "BookingRequest"
UNION ALL SELECT 'distinct phones: ' || count(DISTINCT phone)            FROM "BookingRequest"
UNION ALL SELECT 'earliest: '        || COALESCE(min("createdAt")::text,'-') FROM "BookingRequest"
UNION ALL SELECT 'latest: '          || COALESCE(max("createdAt")::text,'-') FROM "BookingRequest"
UNION ALL SELECT 'status ' || status || ': ' || count(*) FROM "BookingRequest" GROUP BY status;
