export const MAX_BODY_BYTES=2_200_000;
export async function readBody(req) {
  const chunks=[];let bytes=0;
  for await(const chunk of req){bytes+=Buffer.byteLength(chunk);if(bytes>MAX_BODY_BYTES){const e=new Error('Request too large');e.status=413;throw e;}chunks.push(Buffer.from(chunk));}
  return Buffer.concat(chunks).toString('utf8');
}
export function unavailable(res,status=503){res.statusCode=status;res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');res.end(JSON.stringify({ok:false,error:status===413?'big':'unavailable'}));}
