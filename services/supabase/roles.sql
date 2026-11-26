-- Local test passwords for the roles the Supabase services log in as.
alter user authenticator with password 'factory-local-db';
alter user supabase_auth_admin with password 'factory-local-db';
alter user supabase_storage_admin with password 'factory-local-db';
