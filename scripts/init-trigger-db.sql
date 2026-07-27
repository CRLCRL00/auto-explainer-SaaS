-- P1 PR1 follow-up: create the `triggerdev` database used by the trigger-web
-- container (docker-compose.yml trigger-web env points at postgres://...:5432/triggerdev).
--
-- This runs once per `docker compose up` via the init-trigger-db init service.
-- Idempotent: `CREATE DATABASE` already returns a NOTICE on duplicate.
--
-- Run manually if you skip the init service:
--   PGPASSWORD=postgres psql -h localhost -U postgres -d aesaas -f scripts/init-trigger-db.sql
CREATE DATABASE triggerdev;
