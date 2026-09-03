import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import postgres from 'postgres';

import {
  BACKEND_DATASETS,
  EXPECTED_POSTGRES_CATALOG_SHA256,
  MIGRATION_PHASE,
  MIGRATOR_ROLE,
  RECEIPT_FORMAT,
  allTableMetadata,
  assertMigrationPhase,
  assertTargetCountsEmpty,
  atomicEvidenceWrite,
  buildTargetPlan,
  canonicalRowsFromTarget,
  canonicalJson,
  canonicalValue,
  databaseFingerprint,
  evidenceForRows,
  finalManifestViolations,
  loadAndVerifySourceBundle,
  migrationJournalEvidence,
  readJsonFile,
  receiptIdentity,
  sha256,
  tableEvidenceForDataset,
  validateReceipt,
  validateRelationships,
} from './crowdsource-backend-cutover-lib.mjs';

const CUTOVER_LOCK_ID = 0x43524f5744534f55n;
const INSERT_BATCH_SIZE = 200;
export const POSTGRES_CATALOG_FORMAT = 'crowdsource-backend-postgres-catalog/v1';

function postgresClient(connectionUrl) {
  return postgres(connectionUrl, {
    max: 1,
    connect_timeout: 15,
    idle_timeout: 30,
    connection: {
      application_name: 'crowdsource-backend-cutover',
      statement_timeout: 0,
      lock_timeout: 30_000,
    },
  });
}

function safeQuotedIdentifier(value) {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error(`Unsafe PostgreSQL identifier '${value}'.`);
  return `"${value}"`;
}

function publicTableReference(value) {
  return `"public".${safeQuotedIdentifier(value)}`;
}

function sqlColumnName(column) {
  return column.name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * A complete, stable projection of the service-owned PostgreSQL boundary.
 *
 * OIDs and database names are deliberately absent: they vary per installation.
 * Everything that changes the accepted data, row visibility or effective
 * application/migrator authority is present and sorted before hashing.
 */
export async function postgresCatalogEvidence(client) {
  const roles = await client.unsafe(`
    SELECT
      rolname AS name,
      rolcanlogin AS "canLogin",
      rolsuper AS superuser,
      rolinherit AS inherit,
      rolcreaterole AS "createRole",
      rolcreatedb AS "createDatabase",
      rolreplication AS replication,
      rolbypassrls AS "bypassRls",
      rolconnlimit AS "connectionLimit",
      rolvaliduntil::text AS "validUntil",
      rolconfig AS config
    FROM pg_roles
    WHERE rolname ~ '^crowdsource_'
    ORDER BY rolname
  `);
  const roleMemberships = await client.unsafe(`
    SELECT
      granted.rolname AS "grantedRole",
      member.rolname AS member,
      grantor.rolname AS grantor,
      membership.admin_option AS "adminOption",
      membership.inherit_option AS "inheritOption",
      membership.set_option AS "setOption"
    FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    JOIN pg_roles grantor ON grantor.oid = membership.grantor
    WHERE granted.rolname ~ '^crowdsource_'
       OR member.rolname ~ '^crowdsource_'
    ORDER BY granted.rolname, member.rolname, grantor.rolname
  `);
  const database = await client.unsafe(`
    SELECT
      pg_get_userbyid(datdba) AS owner,
      datallowconn AS "allowConnections",
      dathasloginevt AS "hasLoginEvent",
      datconnlimit AS "connectionLimit",
      datistemplate AS template,
      pg_encoding_to_char(encoding) AS encoding,
      datlocprovider AS "localeProvider",
      datcollate AS "collate",
      datctype AS "ctype",
      datlocale AS locale,
      daticurules AS "icuRules",
      datcollversion AS "collationVersion",
      tablespace.spcname AS tablespace
    FROM pg_database database_record
    JOIN pg_tablespace tablespace ON tablespace.oid = database_record.dattablespace
    WHERE datname = current_database()
  `);
  const roleSettings = await client.unsafe(`
    SELECT
      CASE WHEN setting.setdatabase = 0 THEN '*'
        ELSE 'current_database'
      END AS database,
      CASE WHEN setting.setrole = 0 THEN 'ALL'
        ELSE role_record.rolname
      END AS role,
      configured.value AS setting
    FROM pg_db_role_setting setting
    LEFT JOIN pg_roles role_record ON role_record.oid = setting.setrole
    CROSS JOIN LATERAL unnest(setting.setconfig) configured(value)
    WHERE setting.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
      AND (setting.setrole = 0 OR role_record.rolname ~ '^crowdsource_')
    ORDER BY database, role, configured.value
  `);
  const namespaces = await client.unsafe(`
    SELECT
      namespace.nspname AS name,
      namespace_owner.rolname AS owner
    FROM pg_namespace namespace
    JOIN pg_roles namespace_owner ON namespace_owner.oid = namespace.nspowner
    WHERE namespace.nspname !~ '^pg_'
      AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname
  `);
  const objects = await client.unsafe(`
    SELECT
      namespace.nspname AS schema,
      relation.relname AS name,
      relation.relkind AS kind,
      relation.relpersistence AS persistence,
      relation_owner.rolname AS owner,
      relation.relrowsecurity AS "rowSecurity",
      relation.relforcerowsecurity AS "forceRowSecurity",
      relation.relispopulated AS populated,
      relation.relispartition AS partition,
      relation.reloptions AS options
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles relation_owner ON relation_owner.oid = relation.relowner
    WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND namespace.nspname !~ '^pg_'
      AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname, relation.relname
  `);
  const columns = await client.unsafe(`
    SELECT
      namespace.nspname AS schema,
      relation.relname AS "tableName",
      attribute.attnum AS position,
      attribute.attname AS name,
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS type,
      attribute.attnotnull AS "notNull",
      pg_get_expr(default_value.adbin, default_value.adrelid, true) AS "defaultExpression",
      nullif(attribute.attidentity, '') AS identity,
      nullif(attribute.attgenerated, '') AS generated,
      CASE WHEN attribute.attcollation = 0 THEN NULL
        ELSE quote_ident(collation_namespace.nspname) || '.' || quote_ident(collation_record.collname)
      END AS collation
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles relation_owner ON relation_owner.oid = relation.relowner
    LEFT JOIN pg_attrdef default_value
      ON default_value.adrelid = attribute.attrelid
     AND default_value.adnum = attribute.attnum
    LEFT JOIN pg_collation collation_record ON collation_record.oid = attribute.attcollation
    LEFT JOIN pg_namespace collation_namespace ON collation_namespace.oid = collation_record.collnamespace
    WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND namespace.nspname !~ '^pg_'
      AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname, relation.relname, attribute.attnum
  `);
  const constraints = await client.unsafe(`
    SELECT
      namespace.nspname AS schema,
      relation.relname AS "tableName",
      constraint_record.conname AS name,
      constraint_record.contype AS type,
      constraint_record.condeferrable AS deferrable,
      constraint_record.condeferred AS "initiallyDeferred",
      constraint_record.convalidated AS validated,
      pg_get_constraintdef(constraint_record.oid, true) AS definition
    FROM pg_constraint constraint_record
    JOIN pg_class relation ON relation.oid = constraint_record.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles relation_owner ON relation_owner.oid = relation.relowner
    WHERE namespace.nspname !~ '^pg_'
      AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname, relation.relname, constraint_record.conname
  `);
  const indexes = await client.unsafe(`
    SELECT
      namespace.nspname AS schema,
      relation.relname AS "tableName",
      index_relation.relname AS name,
      index_record.indisunique AS unique,
      index_record.indisprimary AS primary,
      index_record.indisexclusion AS exclusion,
      index_record.indimmediate AS immediate,
      index_record.indisvalid AS valid,
      index_record.indisready AS ready,
      index_record.indislive AS live,
      pg_get_indexdef(index_record.indexrelid, 0, true) AS definition,
      pg_get_expr(index_record.indpred, index_record.indrelid, true) AS predicate
    FROM pg_index index_record
    JOIN pg_class relation ON relation.oid = index_record.indrelid
    JOIN pg_class index_relation ON index_relation.oid = index_record.indexrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles relation_owner ON relation_owner.oid = relation.relowner
    WHERE namespace.nspname !~ '^pg_'
      AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname, relation.relname, index_relation.relname
  `);
  const policies = await client.unsafe(`
    SELECT
      namespace.nspname AS schema,
      relation.relname AS "tableName",
      policy.polname AS name,
      policy.polpermissive AS permissive,
      policy.polcmd AS command,
      ARRAY(
        SELECT CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE role_record.rolname END
        FROM unnest(policy.polroles) role_oid
        LEFT JOIN pg_roles role_record ON role_record.oid = role_oid
        ORDER BY CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE role_record.rolname END
      ) AS roles,
      pg_get_expr(policy.polqual, policy.polrelid, true) AS qualifier,
      pg_get_expr(policy.polwithcheck, policy.polrelid, true) AS "withCheck"
    FROM pg_policy policy
    JOIN pg_class relation ON relation.oid = policy.polrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles relation_owner ON relation_owner.oid = relation.relowner
    WHERE namespace.nspname !~ '^pg_'
      AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname, relation.relname, policy.polname
  `);
  const inheritance = await client.unsafe(`
    SELECT
      child_namespace.nspname AS "childSchema",
      child.relname AS child,
      parent_namespace.nspname AS "parentSchema",
      parent.relname AS parent,
      inherited.inhseqno AS position
    FROM pg_inherits inherited
    JOIN pg_class child ON child.oid = inherited.inhrelid
    JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = inherited.inhparent
    JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
    JOIN pg_roles child_owner ON child_owner.oid = child.relowner
    JOIN pg_roles parent_owner ON parent_owner.oid = parent.relowner
    WHERE (
        child_namespace.nspname !~ '^pg_'
        AND child_namespace.nspname <> 'information_schema'
      ) OR (
        parent_namespace.nspname !~ '^pg_'
        AND parent_namespace.nspname <> 'information_schema'
      )
    ORDER BY child_namespace.nspname, child.relname, inherited.inhseqno
  `);
  const types = await client.unsafe(`
    SELECT
      namespace.nspname AS schema,
      type_record.typname AS name,
      type_record.typtype AS kind,
      type_owner.rolname AS owner,
      CASE WHEN type_record.typbasetype = 0 THEN NULL
        ELSE pg_catalog.format_type(type_record.typbasetype, type_record.typtypmod)
      END AS "baseType",
      type_record.typnotnull AS "notNull",
      type_record.typdefault AS "defaultExpression",
      type_record.typisdefined AS defined,
      CASE WHEN type_record.typcollation = 0 THEN NULL
        ELSE quote_ident(collation_namespace.nspname) || '.' || quote_ident(collation_record.collname)
      END AS collation,
      ARRAY(
        SELECT enum.enumlabel
        FROM pg_enum enum
        WHERE enum.enumtypid = type_record.oid
        ORDER BY enum.enumsortorder
      ) AS labels
    FROM pg_type type_record
    JOIN pg_namespace namespace ON namespace.oid = type_record.typnamespace
    JOIN pg_roles type_owner ON type_owner.oid = type_record.typowner
    LEFT JOIN pg_class type_relation ON type_relation.oid = type_record.typrelid
    LEFT JOIN pg_collation collation_record ON collation_record.oid = type_record.typcollation
    LEFT JOIN pg_namespace collation_namespace ON collation_namespace.oid = collation_record.collnamespace
    WHERE (
        type_record.typtype IN ('d', 'e', 'r', 'm')
        OR (type_record.typtype = 'c' AND type_relation.relkind = 'c')
      )
      AND namespace.nspname !~ '^pg_'
      AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname, type_record.typname
  `);
  const domainConstraints = await client.unsafe(`
    SELECT
      namespace.nspname AS schema,
      type_record.typname AS "typeName",
      constraint_record.conname AS name,
      constraint_record.convalidated AS validated,
      constraint_record.condeferrable AS deferrable,
      constraint_record.condeferred AS "initiallyDeferred",
      pg_get_constraintdef(constraint_record.oid, true) AS definition
    FROM pg_constraint constraint_record
    JOIN pg_type type_record ON type_record.oid = constraint_record.contypid
    JOIN pg_namespace namespace ON namespace.oid = type_record.typnamespace
    JOIN pg_roles type_owner ON type_owner.oid = type_record.typowner
    WHERE constraint_record.contypid <> 0
      AND namespace.nspname !~ '^pg_'
      AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname, type_record.typname, constraint_record.conname
  `);
  const collations = await client.unsafe(`
    SELECT
      namespace.nspname AS schema,
      collation_record.collname AS name,
      collation_owner.rolname AS owner,
      collation_record.collprovider AS provider,
      collation_record.collisdeterministic AS deterministic,
      collation_record.collencoding AS encoding,
      collation_record.collcollate AS "lcCollate",
      collation_record.collctype AS "lcCtype",
      collation_record.colllocale AS locale,
      collation_record.collicurules AS "icuRules",
      collation_record.collversion AS version
    FROM pg_collation collation_record
    JOIN pg_namespace namespace ON namespace.oid = collation_record.collnamespace
    JOIN pg_roles collation_owner ON collation_owner.oid = collation_record.collowner
    WHERE namespace.nspname !~ '^pg_'
      AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname, collation_record.collname,
      collation_record.collencoding
  `);
  const sequences = await client.unsafe(`
    SELECT
      namespace.nspname AS schema,
      relation.relname AS name,
      sequence_owner.rolname AS owner,
      pg_catalog.format_type(sequence_record.seqtypid, NULL) AS type,
      sequence_record.seqstart::text AS start,
      sequence_record.seqincrement::text AS increment,
      sequence_record.seqmin::text AS minimum,
      sequence_record.seqmax::text AS maximum,
      sequence_record.seqcache::text AS cache,
      sequence_record.seqcycle AS cycle
    FROM pg_sequence sequence_record
    JOIN pg_class relation ON relation.oid = sequence_record.seqrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles sequence_owner ON sequence_owner.oid = relation.relowner
    WHERE namespace.nspname !~ '^pg_'
      AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname, relation.relname
  `);
  const aggregates = await client.unsafe(`
    SELECT
      namespace.nspname AS schema,
      aggregate_function.proname AS name,
      pg_get_function_identity_arguments(aggregate_function.oid) AS arguments,
      aggregate_record.aggkind AS kind,
      aggregate_record.aggnumdirectargs AS "directArguments",
      aggregate_record.aggtransfn::regprocedure::text AS "transitionFunction",
      aggregate_record.aggfinalfn::regprocedure::text AS "finalFunction",
      aggregate_record.aggcombinefn::regprocedure::text AS "combineFunction",
      aggregate_record.aggserialfn::regprocedure::text AS "serialFunction",
      aggregate_record.aggdeserialfn::regprocedure::text AS "deserialFunction",
      aggregate_record.aggmtransfn::regprocedure::text AS "movingTransitionFunction",
      aggregate_record.aggminvtransfn::regprocedure::text AS "movingInverseTransitionFunction",
      aggregate_record.aggmfinalfn::regprocedure::text AS "movingFinalFunction",
      aggregate_record.aggfinalextra AS "finalExtra",
      aggregate_record.aggmfinalextra AS "movingFinalExtra",
      aggregate_record.aggfinalmodify AS "finalModify",
      aggregate_record.aggmfinalmodify AS "movingFinalModify",
      aggregate_record.aggsortop::regoperator::text AS "sortOperator",
      pg_catalog.format_type(aggregate_record.aggtranstype, NULL) AS "transitionType",
      aggregate_record.aggtransspace AS "transitionSpace",
      pg_catalog.format_type(aggregate_record.aggmtranstype, NULL) AS "movingTransitionType",
      aggregate_record.aggmtransspace AS "movingTransitionSpace",
      aggregate_record.agginitval AS "initialValue",
      aggregate_record.aggminitval AS "movingInitialValue"
    FROM pg_aggregate aggregate_record
    JOIN pg_proc aggregate_function ON aggregate_function.oid = aggregate_record.aggfnoid
    JOIN pg_namespace namespace ON namespace.oid = aggregate_function.pronamespace
    WHERE namespace.nspname !~ '^pg_'
      AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname, aggregate_function.proname,
      pg_get_function_identity_arguments(aggregate_function.oid)
  `);
  const triggers = await client.unsafe(`
    SELECT
      namespace.nspname AS schema,
      relation.relname AS "tableName",
      trigger_record.tgname AS name,
      trigger_record.tgenabled AS enabled,
      pg_get_triggerdef(trigger_record.oid, true) AS definition,
      function_namespace.nspname AS "functionSchema",
      function_record.proname AS "functionName",
      pg_get_function_identity_arguments(function_record.oid) AS "functionArguments"
    FROM pg_trigger trigger_record
    JOIN pg_class relation ON relation.oid = trigger_record.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_proc function_record ON function_record.oid = trigger_record.tgfoid
    JOIN pg_namespace function_namespace ON function_namespace.oid = function_record.pronamespace
    JOIN pg_roles relation_owner ON relation_owner.oid = relation.relowner
    WHERE NOT trigger_record.tgisinternal
      AND namespace.nspname !~ '^pg_'
      AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname, relation.relname, trigger_record.tgname
  `);
  const functions = await client.unsafe(`
    SELECT
      namespace.nspname AS schema,
      function_record.proname AS name,
      pg_get_function_identity_arguments(function_record.oid) AS arguments,
      pg_get_function_result(function_record.oid) AS result,
      language.lanname AS language,
      function_record.prokind AS kind,
      function_record.provolatile AS volatility,
      function_record.proparallel AS parallel,
      function_record.prosecdef AS "securityDefiner",
      function_record.proleakproof AS leakproof,
      function_record.proisstrict AS strict,
      function_record.proretset AS "returnsSet",
      function_record.proconfig AS config,
      function_owner.rolname AS owner,
      CASE WHEN function_record.prokind = 'a' THEN NULL
        ELSE pg_get_functiondef(function_record.oid)
      END AS definition
    FROM pg_proc function_record
    JOIN pg_namespace namespace ON namespace.oid = function_record.pronamespace
    JOIN pg_language language ON language.oid = function_record.prolang
    JOIN pg_roles function_owner ON function_owner.oid = function_record.proowner
    WHERE function_record.prokind IN ('f', 'p', 'a', 'w')
      AND namespace.nspname !~ '^pg_'
      AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname, function_record.proname,
      pg_get_function_identity_arguments(function_record.oid)
  `);
  const privileges = await client.unsafe(`
    SELECT * FROM (
      SELECT
        'database'::text AS "objectKind",
        'current_database'::text AS schema,
        'current_database'::text AS object,
        grantor.rolname AS grantor,
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
        privilege.privilege_type AS privilege,
        privilege.is_grantable AS "grantable"
      FROM pg_database database_record
      CROSS JOIN LATERAL aclexplode(
        COALESCE(database_record.datacl, acldefault('d', database_record.datdba))
      ) privilege
      JOIN pg_roles grantor ON grantor.oid = privilege.grantor
      LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
      WHERE database_record.datname = current_database()
      UNION ALL
      SELECT
        'schema', namespace.nspname, namespace.nspname,
        grantor.rolname,
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END,
        privilege.privilege_type,
        privilege.is_grantable
      FROM pg_namespace namespace
      JOIN pg_roles namespace_owner ON namespace_owner.oid = namespace.nspowner
      CROSS JOIN LATERAL aclexplode(
        COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
      ) privilege
      JOIN pg_roles grantor ON grantor.oid = privilege.grantor
      LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
      WHERE namespace.nspname !~ '^pg_'
        AND namespace.nspname <> 'information_schema'
      UNION ALL
      SELECT
        CASE WHEN relation.relkind = 'S' THEN 'sequence' ELSE 'relation' END,
        namespace.nspname,
        relation.relname,
        grantor.rolname,
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END,
        privilege.privilege_type,
        privilege.is_grantable
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN pg_roles relation_owner ON relation_owner.oid = relation.relowner
      CROSS JOIN LATERAL aclexplode(COALESCE(
        relation.relacl,
        acldefault(
          (CASE WHEN relation.relkind = 'S' THEN 'S' ELSE 'r' END)::"char",
          relation.relowner
        )
      )) privilege
      JOIN pg_roles grantor ON grantor.oid = privilege.grantor
      LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
      WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND namespace.nspname !~ '^pg_'
        AND namespace.nspname <> 'information_schema'
      UNION ALL
      SELECT
        'function', namespace.nspname,
        function_record.proname || '(' || pg_get_function_identity_arguments(function_record.oid) || ')',
        grantor.rolname,
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END,
        privilege.privilege_type,
        privilege.is_grantable
      FROM pg_proc function_record
      JOIN pg_namespace namespace ON namespace.oid = function_record.pronamespace
      JOIN pg_roles function_owner ON function_owner.oid = function_record.proowner
      CROSS JOIN LATERAL aclexplode(
        COALESCE(function_record.proacl, acldefault('f', function_record.proowner))
      ) privilege
      JOIN pg_roles grantor ON grantor.oid = privilege.grantor
      LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
      WHERE function_record.prokind IN ('f', 'p', 'a', 'w')
        AND namespace.nspname !~ '^pg_'
        AND namespace.nspname <> 'information_schema'
      UNION ALL
      SELECT
        'type', namespace.nspname,
        type_record.typname,
        grantor.rolname,
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END,
        privilege.privilege_type,
        privilege.is_grantable
      FROM pg_type type_record
      JOIN pg_namespace namespace ON namespace.oid = type_record.typnamespace
      JOIN pg_roles type_owner ON type_owner.oid = type_record.typowner
      LEFT JOIN pg_class type_relation ON type_relation.oid = type_record.typrelid
      CROSS JOIN LATERAL aclexplode(
        COALESCE(type_record.typacl, acldefault('T', type_record.typowner))
      ) privilege
      JOIN pg_roles grantor ON grantor.oid = privilege.grantor
      LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
      WHERE (
          type_record.typtype IN ('d', 'e', 'r', 'm')
          OR (type_record.typtype = 'c' AND type_relation.relkind = 'c')
        )
        AND namespace.nspname !~ '^pg_'
        AND namespace.nspname <> 'information_schema'
    ) grants
    ORDER BY "objectKind", schema, object, grantee, privilege, grantor
  `);
  const columnPrivileges = await client.unsafe(`
    SELECT
      namespace.nspname AS schema,
      relation.relname AS "tableName",
      attribute.attname AS column,
      grantor.rolname AS grantor,
      CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
      privilege.privilege_type AS privilege,
      privilege.is_grantable AS grantable
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles relation_owner ON relation_owner.oid = relation.relowner
    CROSS JOIN LATERAL aclexplode(attribute.attacl) privilege
    JOIN pg_roles grantor ON grantor.oid = privilege.grantor
    LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
    WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
      AND namespace.nspname !~ '^pg_'
      AND namespace.nspname <> 'information_schema'
    ORDER BY namespace.nspname, relation.relname, attribute.attname,
      grantee, privilege.privilege_type, grantor.rolname
  `);
  const defaultPrivileges = await client.unsafe(`
    SELECT
      owner.rolname AS owner,
      COALESCE(namespace.nspname, '*') AS schema,
      default_acl.defaclobjtype AS "objectKind",
      grantor.rolname AS grantor,
      CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee,
      privilege.privilege_type AS privilege,
      privilege.is_grantable AS grantable
    FROM pg_default_acl default_acl
    JOIN pg_roles owner ON owner.oid = default_acl.defaclrole
    LEFT JOIN pg_namespace namespace ON namespace.oid = default_acl.defaclnamespace
    CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) privilege
    JOIN pg_roles grantor ON grantor.oid = privilege.grantor
    LEFT JOIN pg_roles grantee ON grantee.oid = privilege.grantee
    WHERE namespace.oid IS NULL
       OR (namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema')
    ORDER BY owner.rolname, schema, default_acl.defaclobjtype, grantee, privilege.privilege_type
  `);

  return {
    format: POSTGRES_CATALOG_FORMAT,
    roles,
    roleMemberships,
    database,
    roleSettings,
    namespaces,
    objects,
    columns,
    constraints,
    indexes,
    policies,
    inheritance,
    types,
    domainConstraints,
    collations,
    sequences,
    aggregates,
    triggers,
    functions,
    privileges,
    columnPrivileges,
    defaultPrivileges,
  };
}

export async function assertPostgresTarget(client, targetDatabase) {
  const [identity] = await client.unsafe(`
    SELECT
      current_user AS "currentUser",
      current_database() AS "currentDatabase",
      role.rolsuper AS "isSuperuser",
      role.rolbypassrls AS "bypassesRls",
      pg_get_userbyid(database.datdba) AS "databaseOwner"
    FROM pg_roles role
    JOIN pg_database database ON database.datname = current_database()
    WHERE role.rolname = current_user
  `);
  if (identity === undefined) throw new Error('PostgreSQL did not return the connected role identity.');
  if (identity.currentUser !== MIGRATOR_ROLE) {
    throw new Error(`Cutover requires role '${MIGRATOR_ROLE}', connected as '${identity.currentUser}'.`);
  }
  if (identity.currentDatabase !== targetDatabase) {
    throw new Error(`Connected database '${identity.currentDatabase}' is not '${targetDatabase}'.`);
  }
  if (identity.databaseOwner !== MIGRATOR_ROLE) {
    throw new Error(`Database '${targetDatabase}' is not owned by '${MIGRATOR_ROLE}'.`);
  }
  if (identity.isSuperuser || identity.bypassesRls) {
    throw new Error(`Role '${MIGRATOR_ROLE}' is privileged beyond the reviewed topology.`);
  }

  const catalog = await postgresCatalogEvidence(client);
  const catalogSha256 = sha256(catalog);
  if (catalogSha256 !== EXPECTED_POSTGRES_CATALOG_SHA256) {
    throw new Error(
      'PostgreSQL catalog differs from the pinned types, defaults, constraints, indexes, RLS, ' +
      `policies, grants, roles, triggers or functions (expected ${EXPECTED_POSTGRES_CATALOG_SHA256}; ` +
      `found ${catalogSha256}).`,
    );
  }

  const metadata = await allTableMetadata();
  const journal = migrationJournalEvidence();
  const ledgerRows = await client.unsafe(`
    SELECT hash, created_at::text AS "createdAt"
    FROM drizzle.__drizzle_migrations
    ORDER BY created_at, id
  `);
  const expectedLedger = journal.migrations.map((migration) => ({
    hash: createHash('sha256').update(migration.sql).digest('hex'),
    createdAt: String(migration.when),
  }));
  if (canonicalJson(ledgerRows) !== canonicalJson(expectedLedger)) {
    throw new Error(
      'PostgreSQL migration ledger hashes and timestamps are not the complete pinned phase=all journal.',
    );
  }
  return { metadata, journal, catalogSha256 };
}

export async function countTargetRows(client, providedMetadata) {
  const metadata = providedMetadata ?? await allTableMetadata();
  const counts = {};
  for (const table of metadata) {
    const [row] = await client.unsafe(
      `SELECT count(*)::integer AS count FROM ${publicTableReference(table.tableName)}`,
    );
    counts[table.tableKey] = row?.count;
  }
  return counts;
}

function databaseRow(row, columns, label) {
  const converted = {};
  for (const [field, column] of Object.entries(columns)) {
    const value = row[field];
    if (value !== null && column.dataType === 'date') {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new Error(`${label}.${field} is not a valid timestamp.`);
      converted[field] = date;
    } else {
      converted[field] = value;
    }
  }
  return converted;
}

async function insertTargetPlan(transaction, metadata, rowsByTableKey) {
  for (const table of metadata) {
    const rows = rowsByTableKey[table.tableKey];
    for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
      const batch = rows
        .slice(offset, offset + INSERT_BATCH_SIZE)
        .map((row, index) => databaseRow(row, table.columns, `${table.tableName}[${offset + index}]`));
      const columns = Object.entries(table.columns);
      const values = [];
      const tuples = batch.map((row) => {
        const placeholders = columns.map(([field, column]) => {
          let value = row[field];
          values.push(column.dataType === 'json' && value !== null ? JSON.stringify(value) : value);
          const placeholder = `$${values.length}`;
          if (column.dataType === 'json') return `${placeholder}::jsonb`;
          if (column.dataType === 'array') return `${placeholder}::text[]`;
          return placeholder;
        });
        return `(${placeholders.join(', ')})`;
      });
      const columnList = columns
        .map(([, column]) => safeQuotedIdentifier(sqlColumnName(column)))
        .join(', ');
      await transaction.unsafe(
        `INSERT INTO ${publicTableReference(table.tableName)} (${columnList}) VALUES ${tuples.join(', ')}`,
        values,
      );
    }
  }
}

export async function readTargetRows(client, providedMetadata) {
  const metadata = providedMetadata ?? await allTableMetadata();
  const rowsByTableKey = {};
  for (const table of metadata) {
    const selectedColumns = Object.values(table.columns)
      .map((column) => safeQuotedIdentifier(sqlColumnName(column)))
      .join(', ');
    const rows = await client.unsafe(
      `SELECT ${selectedColumns} FROM ${publicTableReference(table.tableName)}`,
    );
    const fieldByColumn = new Map(
      Object.entries(table.columns).map(([field, column]) => [sqlColumnName(column), { field, column }]),
    );
    rowsByTableKey[table.tableKey] = rows.map((row) => canonicalValue(Object.fromEntries(
      Object.entries(row).map(([column, value]) => {
        const binding = fieldByColumn.get(column);
        if (binding === undefined) throw new Error(`Unexpected column '${column}' from '${table.tableName}'.`);
        let canonicalValueFromDatabase = value;
        if (binding.column.dataType === 'json' && typeof value === 'string') {
          try {
            canonicalValueFromDatabase = JSON.parse(value);
          } catch {
            throw new Error(`PostgreSQL returned invalid JSON for '${table.tableName}.${column}'.`);
          }
        }
        return [binding.field, canonicalValueFromDatabase];
      }),
    )));
  }
  validateRelationships(rowsByTableKey);
  return rowsByTableKey;
}

function canonicalDifferenceSummary(sourceRows, targetRows, identity, label) {
  const source = evidenceForRows(sourceRows, identity, `${label} source`).rows;
  const target = evidenceForRows(targetRows, identity, `${label} target`).rows;
  if (source.length !== target.length) return 'row count';
  const changedFields = new Set();
  const valueKind = (value) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  for (let index = 0; index < source.length; index += 1) {
    const sourceIdentity = Object.fromEntries(identity.map((field) => [field, source[index][field]]));
    const targetIdentity = Object.fromEntries(identity.map((field) => [field, target[index][field]]));
    if (canonicalJson(sourceIdentity) !== canonicalJson(targetIdentity)) return 'identity set';
    const fields = new Set([...Object.keys(source[index]), ...Object.keys(target[index])]);
    for (const field of fields) {
      if (
        Object.hasOwn(source[index], field) !== Object.hasOwn(target[index], field) ||
        canonicalJson(source[index][field]) !== canonicalJson(target[index][field])
      ) {
        if (!Object.hasOwn(source[index], field) || !Object.hasOwn(target[index], field)) {
          changedFields.add(`${field} (presence)`);
        } else {
          const sourceKind = valueKind(source[index][field]);
          const targetKind = valueKind(target[index][field]);
          changedFields.add(
            sourceKind === targetKind ? `${field} (value)` : `${field} (${sourceKind}->${targetKind})`,
          );
        }
      }
    }
  }
  return changedFields.size === 0 ? 'unknown canonical bytes' : `fields ${[...changedFields].sort().join(', ')}`;
}

export async function reconcileTarget(sourceBundle, rowsByTableKey, target) {
  const datasets = [];
  const differenceSummaries = [];
  let targetTotalCount = 0;
  for (let index = 0; index < BACKEND_DATASETS.length; index += 1) {
    const fixed = BACKEND_DATASETS[index];
    const sourceEntry = sourceBundle.manifest.datasets[index];
    const canonicalRows = await canonicalRowsFromTarget(fixed.name, rowsByTableKey);
    const targetEvidence = evidenceForRows(canonicalRows, fixed.identity, `${fixed.name} target`);
    if (
      sourceEntry.sourceCount !== targetEvidence.count ||
      sourceEntry.sourceSha256 !== targetEvidence.sha256 ||
      sourceEntry.sourceIdentitySha256 !== targetEvidence.identitySha256
    ) {
      differenceSummaries.push(
        `${fixed.name}: ${canonicalDifferenceSummary(
          sourceBundle.canonicalRowsByDataset[fixed.name],
          canonicalRows,
          fixed.identity,
          fixed.name,
        )}`,
      );
    }
    const tableEvidence = await tableEvidenceForDataset(fixed.name, rowsByTableKey, 'target');
    const tables = sourceEntry.tables.map((sourceTable, tableIndex) => ({
      ...sourceTable,
      ...tableEvidence[tableIndex],
    }));
    datasets.push({
      ...sourceEntry,
      targetCount: targetEvidence.count,
      targetSha256: targetEvidence.sha256,
      targetIdentitySha256: targetEvidence.identitySha256,
      tables,
    });
    targetTotalCount += targetEvidence.count;
  }
  const finalManifest = {
    ...sourceBundle.manifest,
    target: {
      databaseName: target.databaseName,
      databaseFingerprint: target.databaseFingerprint,
      checkedAt: target.checkedAt,
      migratorRole: MIGRATOR_ROLE,
      emptyBeforeImport: true,
      isolationLevel: 'serializable',
      schemaAndOwnerVerified: true,
      migrationLedgerVerified: true,
      postgresCatalogSha256: target.postgresCatalogSha256,
      totalCount: targetTotalCount,
      importReceiptSha256: target.importReceiptSha256,
    },
    datasets,
  };
  const violations = finalManifestViolations(finalManifest);
  if (violations.length > 0) {
    const summaries = differenceSummaries.length === 0
      ? ''
      : `\n  - Safe field-only diagnostics: ${differenceSummaries.join('; ')}`;
    throw new Error(
      `PostgreSQL reconciliation refused:\n${violations.map((entry) => `  - ${entry}`).join('\n')}${summaries}`,
    );
  }
  return finalManifest;
}

function expectedReceiptFields(sourceBundle, targetDatabase, targetFingerprint) {
  return {
    sourceManifestSha256: sourceBundle.manifestSha256,
    sourceDatabaseFingerprint: sourceBundle.manifest.source.databaseFingerprint,
    targetDatabase,
    targetDatabaseFingerprint: targetFingerprint,
    migrationJournalSha256: sourceBundle.manifest.migrationJournalSha256,
  };
}

function readExistingReceipt(receiptPath, expected) {
  if (!existsSync(receiptPath)) return undefined;
  const receipt = readJsonFile(receiptPath, 'Import receipt');
  validateReceipt(receipt, expected);
  return receipt;
}

export async function importPostgres({
  bundleDirectory,
  receiptPath,
  connectionUrl,
  targetDatabase,
  expectedTargetFingerprint,
  phase,
}) {
  assertMigrationPhase(phase);
  const targetFingerprint = databaseFingerprint(connectionUrl, targetDatabase, 'postgresql');
  if (targetFingerprint !== expectedTargetFingerprint) {
    throw new Error('PostgreSQL endpoint does not match --expected-target-fingerprint.');
  }
  const sourceBundle = await loadAndVerifySourceBundle(bundleDirectory);
  if (sourceBundle.manifest.source.databaseFingerprint === targetFingerprint) {
    throw new Error('Source and target database fingerprints are identical.');
  }
  const targetPlan = await buildTargetPlan(sourceBundle.canonicalRowsByDataset);
  const receiptFile = resolve(receiptPath);
  const receiptExpected = expectedReceiptFields(sourceBundle, targetDatabase, targetFingerprint);
  let receipt = readExistingReceipt(receiptFile, receiptExpected);
  const client = postgresClient(connectionUrl);
  let idempotent = false;
  try {
    const { metadata, journal, catalogSha256 } = await assertPostgresTarget(client, targetDatabase);
    await client.begin('isolation level serializable read write', async (transaction) => {
      await transaction.unsafe(`SELECT pg_advisory_xact_lock($1::bigint)`, [CUTOVER_LOCK_ID.toString()]);
      const lockList = metadata.map((table) => publicTableReference(table.tableName)).join(', ');
      await transaction.unsafe(`LOCK TABLE ${lockList} IN ACCESS EXCLUSIVE MODE`);
      const counts = await countTargetRows(transaction, metadata);
      const targetHasRows = Object.values(counts).some((count) => count !== 0);
      if (targetHasRows) {
        if (receipt === undefined) {
          throw new Error('Target is non-empty and has no matching prepared/committed import receipt.');
        }
        const actualRows = await readTargetRows(transaction, metadata);
        await reconcileTarget(sourceBundle, actualRows, {
          databaseName: targetDatabase,
          databaseFingerprint: targetFingerprint,
          checkedAt: new Date().toISOString(),
          postgresCatalogSha256: catalogSha256,
          importReceiptSha256: sha256(`${canonicalJson(receipt)}\n`),
        });
        idempotent = true;
        return;
      }
      assertTargetCountsEmpty(counts);
      if (receipt?.state === 'committed') {
        throw new Error('A committed receipt exists but the target is empty; refusing silent re-import.');
      }
      const emptyCheckedAt = new Date().toISOString();
      receipt = {
        format: RECEIPT_FORMAT,
        schemaVersion: 1,
        state: 'prepared',
        migrationPhase: MIGRATION_PHASE,
        emptyBeforeImport: true,
        emptyCheckedAt,
        ...receiptExpected,
        importIdentity: receiptIdentity({
          sourceManifestSha256: sourceBundle.manifestSha256,
          targetDatabaseFingerprint: targetFingerprint,
          journalSha256: journal.sha256,
        }),
      };
      atomicEvidenceWrite(receiptFile, receipt);
      await insertTargetPlan(transaction, metadata, targetPlan);
      const insertedRows = await readTargetRows(transaction, metadata);
      await reconcileTarget(sourceBundle, insertedRows, {
        databaseName: targetDatabase,
        databaseFingerprint: targetFingerprint,
        checkedAt: new Date().toISOString(),
        postgresCatalogSha256: catalogSha256,
        importReceiptSha256: sha256(`${canonicalJson(receipt)}\n`),
      });
    });
  } finally {
    await client.end();
  }
  const committedReceipt = {
    ...receipt,
    state: 'committed',
    committedAt: receipt?.committedAt ?? new Date().toISOString(),
  };
  atomicEvidenceWrite(receiptFile, committedReceipt);
  return { receipt: committedReceipt, idempotent };
}

export async function reexportPostgres({
  bundleDirectory,
  receiptPath,
  outputManifestPath,
  connectionUrl,
  targetDatabase,
  expectedTargetFingerprint,
  phase,
}) {
  assertMigrationPhase(phase);
  if (existsSync(outputManifestPath)) throw new Error(`Output manifest '${outputManifestPath}' exists.`);
  const targetFingerprint = databaseFingerprint(connectionUrl, targetDatabase, 'postgresql');
  if (targetFingerprint !== expectedTargetFingerprint) {
    throw new Error('PostgreSQL endpoint does not match --expected-target-fingerprint.');
  }
  const sourceBundle = await loadAndVerifySourceBundle(bundleDirectory);
  const expected = expectedReceiptFields(sourceBundle, targetDatabase, targetFingerprint);
  const receipt = readExistingReceipt(resolve(receiptPath), expected);
  if (receipt?.state !== 'committed') throw new Error('A matching committed import receipt is required.');
  const receiptBytes = readFileSync(resolve(receiptPath), 'utf8');
  const client = postgresClient(connectionUrl);
  let manifest;
  try {
    const { metadata, catalogSha256 } = await assertPostgresTarget(client, targetDatabase);
    await client.begin('isolation level repeatable read read only', async (transaction) => {
      const rows = await readTargetRows(transaction, metadata);
      manifest = await reconcileTarget(sourceBundle, rows, {
        databaseName: targetDatabase,
        databaseFingerprint: targetFingerprint,
        checkedAt: new Date().toISOString(),
        postgresCatalogSha256: catalogSha256,
        importReceiptSha256: sha256(receiptBytes),
      });
    });
  } finally {
    await client.end();
  }
  atomicEvidenceWrite(resolve(outputManifestPath), manifest);
  return manifest;
}

export function targetFingerprintForUrl(connectionUrl, targetDatabase) {
  return databaseFingerprint(connectionUrl, targetDatabase, 'postgresql');
}
