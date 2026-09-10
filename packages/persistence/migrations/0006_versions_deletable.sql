-- Versions stay immutable, but deleting a workflow removes its versions.
DROP TRIGGER versions_immutable ON versions;
--> statement-breakpoint
CREATE TRIGGER versions_immutable BEFORE UPDATE ON versions
FOR EACH ROW EXECUTE FUNCTION reject_version_mutation();
