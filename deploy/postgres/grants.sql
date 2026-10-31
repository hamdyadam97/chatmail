-- Privileges for the runtime role. Run as the OWNER role after every migrate
-- (deploy.sh does it):  psql "$MIGRATE_DATABASE_URL" -f grants.sql
--
-- corr_owner owns the schema and runs migrations; corr_app is what the
-- running application uses. The append-only audit log
-- gets INSERT/SELECT only, so even a compromised application process cannot
-- rewrite or erase history (§20, ERD ط).

GRANT USAGE ON SCHEMA public TO corr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO corr_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO corr_app;

REVOKE UPDATE, DELETE, TRUNCATE ON audit_logs FROM corr_app;


-- Tables created by future migrations get the default grants; deploy.sh
-- re-runs this file after migrating so the REVOKEs above always apply.
ALTER DEFAULT PRIVILEGES FOR ROLE corr_owner IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO corr_app;
ALTER DEFAULT PRIVILEGES FOR ROLE corr_owner IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO corr_app;
