-- A client that is linked to no resource cannot authorize, so it is deleted.
--
-- The 1.7 migration next door carries every `oauth_application` row over into
-- `oauth_client`, and that carry is incomplete: 1.7 checks the
-- `oauth_client_resource` join table on every authorization request
-- (`assertClientLinkedToResources`) and answers `invalid_target` -- "client X is
-- not linked to resource(s) ..." -- when a link is missing. The plugin writes
-- that link when a client registers; nothing writes it for a client that was
-- already there. The migration could not write it either, because the resource
-- row does not exist while migrations run: the plugin seeds it from its options
-- on first use, and hard-coding a deployment's origin into migration history was
-- the thing that section deliberately refused to do.
--
-- So a client carried over from 1.6 is not a working client, it is a row that
-- turns every reconnect into an OAuth error page. Deleting it is what the
-- carry-over should have been: the connector registers again (registration is
-- open, see `allowDynamicClientRegistration`) and is linked on the way in.
-- Consents and grants follow through `ON DELETE CASCADE`, which is correct --
-- consent recorded for a client that can no longer ask for anything is a
-- statement about nothing.
--
-- Scoped by the absence of a link rather than by a date, because that is the
-- property that makes the row dead, and it is one no live client has: a
-- registration links itself in the same request that creates it.

DELETE FROM "oauth_client"
 WHERE NOT EXISTS (
   SELECT 1
     FROM "oauth_client_resource" link
    WHERE link."clientId" = "oauth_client"."clientId"
 );
