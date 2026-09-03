/* global EJSON, db */

const fs = require('node:fs');
const path = require('node:path');

const sourceDatabase = process.env.CROWDSOURCE_RECOVERY_DATABASE;
const rawDirectory = process.env.CROWDSOURCE_RECOVERY_RAW_DIRECTORY;
const encodedDatasets = process.env.CROWDSOURCE_RECOVERY_DATASETS;
const encodedExpectedCounts = process.env.CROWDSOURCE_RECOVERY_EXPECTED_COUNTS;

if (!sourceDatabase || !rawDirectory || !encodedDatasets || !encodedExpectedCounts) {
  throw new Error('Archive recovery bindings are absent.');
}
if (!/^[A-Za-z0-9_-]{1,63}$/.test(sourceDatabase)) {
  throw new Error('Archive recovery database name is unsafe.');
}

const datasets = JSON.parse(encodedDatasets);
const expectedCounts = JSON.parse(encodedExpectedCounts);
if (
  !Array.isArray(datasets) ||
  datasets.length !== 26 ||
  datasets.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name)) ||
  new Set(datasets).size !== datasets.length ||
  typeof expectedCounts !== 'object' ||
  expectedCounts === null ||
  Array.isArray(expectedCounts) ||
  Object.keys(expectedCounts).length !== datasets.length ||
  datasets.some((name) => !Number.isSafeInteger(expectedCounts[name]) || expectedCounts[name] < 0)
) {
  throw new Error('Archive recovery dataset/count binding is malformed.');
}

const userDatabases = db.getMongo().getDBNames()
  .filter((name) => !['admin', 'config', 'local'].includes(name))
  .sort();
if (userDatabases.length !== 1 || userDatabases[0] !== sourceDatabase) {
  throw new Error('Archive restore contains an unexpected database namespace.');
}

const source = db.getSiblingDB(sourceDatabase);
const collections = source
  .getCollectionInfos({}, { nameOnly: true })
  .map((entry) => entry.name)
  .filter((name) => !name.startsWith('system.'))
  .sort();
const expectedCollections = [...datasets].sort();
if (
  collections.length !== expectedCollections.length ||
  collections.some((name, index) => name !== expectedCollections[index])
) {
  throw new Error('Archive restore does not contain the exact fixed collection census.');
}

const counts = {};
for (const name of datasets) {
  const collection = source.getCollection(name);
  const count = collection.countDocuments({});
  if (count !== expectedCounts[name]) {
    throw new Error(`Archive collection '${name}' differs from the final backup count.`);
  }
  const filename = path.join(rawDirectory, `${name}.extended-json.ndjson`);
  const descriptor = fs.openSync(filename, 'wx', 0o600);
  let written = 0;
  try {
    const cursor = collection.find({}).sort({ _id: 1 });
    while (cursor.hasNext()) {
      fs.writeSync(descriptor, `${EJSON.stringify(cursor.next(), null, 0, { relaxed: false })}\n`);
      written += 1;
    }
  } finally {
    fs.closeSync(descriptor);
    fs.chmodSync(filename, 0o600);
  }
  if (written !== count) throw new Error(`Archive collection '${name}' changed during isolated extraction.`);
  counts[name] = count;
}

const censusPath = path.join(rawDirectory, 'archive-census.json');
fs.writeFileSync(
  censusPath,
  `${JSON.stringify({
    format: 'crowdsource-backend-archive-census/v1',
    databaseName: sourceDatabase,
    collections: datasets.map((name) => ({ name, count: counts[name] })),
  })}\n`,
  { encoding: 'utf8', flag: 'wx', mode: 0o600 },
);
fs.chmodSync(censusPath, 0o600);
