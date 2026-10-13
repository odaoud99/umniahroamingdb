import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist', {recursive:true});
await cp('public', 'dist/public', {recursive:true});
let source=await readFile('src/worker.js','utf8');
for(const [name,path] of [['seed','seed'],['countries','tap_countries'],['report','import-report'],['isoCountries','iso_countries']]){
  const data=JSON.parse(await readFile(`data/${path}.json`,'utf8'));
  source=source.replace(new RegExp(`import ${name} from '[^']+';`),`const ${name} = ${JSON.stringify(data)};`);
}
await writeFile('dist/worker.js',source);
console.log('Built Worker and browser assets.');
