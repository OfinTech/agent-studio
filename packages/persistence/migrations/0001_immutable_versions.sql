-- Published versions are an append-only audit record.
CREATE FUNCTION reject_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published workflow versions are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER versions_immutable BEFORE UPDATE OR DELETE ON versions
FOR EACH ROW EXECUTE FUNCTION reject_version_mutation();
