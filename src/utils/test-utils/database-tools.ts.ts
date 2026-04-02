import {rm} from 'node:fs/promises';
import {exec as execCallback} from 'node:child_process';
import {promisify} from 'node:util';
import SqliteDatabase from 'better-sqlite3';
import {drizzle} from 'drizzle-orm/better-sqlite3';
import {
	uniqueNamesGenerator, adjectives, colors, animals,
} from 'unique-names-generator';
import fg from 'fast-glob';
import * as schema from '@/db/schema.js';
import {type Database} from '@/db/type.js';

const exec = promisify(execCallback);

export const UNIT_TEST_DB_PREFIX = './unit-test-';

type DatabaseMockContext = {
	databaseMock: Database;
	databaseName: string;
	close: () => void;
};

export async function cleanAllLooseDatabases(prefix: string) {
	const entries = await fg([`${prefix}*.db`]);
	await Promise.all(entries.map(async entry => cleanUp(entry)));
}

export async function cleanUp(databaseName: string) {
	await rm(databaseName, {force: true});
}

export async function createDatabaseMock(): Promise<DatabaseMockContext> {
	const randomName = uniqueNamesGenerator({dictionaries: [adjectives, colors, animals]}); // Big_red_donkey
	const databaseName = `${UNIT_TEST_DB_PREFIX}${randomName}.db`;
	const sqlite = new SqliteDatabase(databaseName);
	await exec(`./node_modules/.bin/drizzle-kit push --schema=src/db/schema.ts --dialect=sqlite --url=${databaseName}`);

	const databaseMock = drizzle(sqlite, {
		schema,
	});
	return {databaseMock, databaseName, close: () => sqlite.close()};
}
