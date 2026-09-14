import { createServer } from 'node:http';
import handler from '../../api/index.ts';

const server=createServer((request,response)=>{ void handler(request,response); });

function shutdown(exitCode=0) {
  server.closeAllConnections();
  server.close(()=>process.exit(exitCode));
  setTimeout(()=>process.exit(exitCode),2_000).unref();
}

process.on('message',message=>{
  if (message && typeof message==='object' && 'type' in message && message.type==='shutdown') shutdown();
});
process.once('SIGTERM',()=>shutdown());
process.once('SIGINT',()=>shutdown());
server.once('error',()=>shutdown(1));
server.listen(0,'127.0.0.1',()=>{
  const address=server.address();
  if (!address || typeof address==='string') { shutdown(1); return; }
  process.send?.({type:'listening',port:address.port});
});
