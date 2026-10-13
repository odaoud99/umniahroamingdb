import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createDatabaseAdapter} from '../src/libsql-adapter.mjs';
test('Turso adapter preserves result columns and uses atomic write batches',async()=>{
  const sqlite=new DatabaseSync(':memory:');let batchMode;
  const execute=({sql,args=[]})=>{const statement=sqlite.prepare(sql),columns=statement.columns().map(c=>c.name),rows=statement.all(...args),rowsAffected=sqlite.prepare('SELECT changes() n').get().n;return {columns,rows,rowsAffected,lastInsertRowid:null};};
  const client={async execute(s){return execute(s);},async batch(statements,mode){batchMode=mode;sqlite.exec('BEGIN IMMEDIATE');try{const r=statements.map(execute);sqlite.exec('COMMIT');return r;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
  const db=createDatabaseAdapter(client);await db.prepare('CREATE TABLE examples(id TEXT PRIMARY KEY, value TEXT)').run();
  await db.prepare('INSERT INTO examples VALUES(?,?)').bind('a',null).run();
  assert.deepEqual(await db.prepare('SELECT * FROM examples WHERE id=?').bind('a').first(),{id:'a',value:null});
  await assert.rejects(()=>db.batch([db.prepare('INSERT INTO examples VALUES(?,?)').bind('b','temporary'),db.prepare('INSERT INTO examples VALUES(?,?)').bind('a','duplicate')]));
  assert.equal(batchMode,'write');assert.equal(await db.prepare('SELECT * FROM examples WHERE id=?').bind('b').first(),null);
  sqlite.close();
});
