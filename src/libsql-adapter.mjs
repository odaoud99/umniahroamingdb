/** Adapt Turso/libSQL result sets to the shared database interface. */
export function createDatabaseAdapter(client){
  const result=r=>({results:r.rows.map(row=>Object.fromEntries(r.columns.map((column,i)=>[column,row[column]??row[i]??null]))),success:true,meta:{changes:Number(r.rowsAffected),last_row_id:r.lastInsertRowid==null?null:Number(r.lastInsertRowid)}});
  class Statement{
    constructor(sql,args=[]){this.sql=sql;this.args=args;}
    bind(...args){return new Statement(this.sql,args);}
    async first(){return result(await client.execute({sql:this.sql,args:this.args})).results[0]||null;}
    async all(){return result(await client.execute({sql:this.sql,args:this.args}));}
    async run(){return result(await client.execute({sql:this.sql,args:this.args}));}
  }
  return {prepare(sql){return new Statement(sql);},async batch(statements){return (await client.batch(statements.map(s=>({sql:s.sql,args:s.args})),'write')).map(result);}};
}
