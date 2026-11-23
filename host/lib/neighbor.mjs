// Booking agreements and private conversations share the booking's retention
// and capability boundaries. Prices are integer cents, calculated here rather
// than accepted from the browser or the advertised starting price.
export function escapeNeighbor(value) {
  return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
export function quoteAccepted(row) {
  return !!(row?.quote && row.quote.acceptedAt && row.quote.acceptedRevision === row.quote.revision);
}
export function quoteStatus(row) { return !row?.quote ? 'none' : quoteAccepted(row) ? 'accepted' : 'awaiting-acceptance'; }
export function agreedPrice(row) {
  if (row?.quote) return quoteAccepted(row) ? (row.quote.totalCents / 100).toFixed(2) : '';
  return String(row?.fields?.price || '');
}
export function money(cents) { return '$' + (cents / 100).toFixed(2); }
export function operationId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value) ? value : ''; }
function boundedText(value,max,required=false) {
  if (typeof value !== 'string') return required ? null : '';
  const text=value.replace(/\r\n?/g,'\n').trim();
  return text.length>max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text) || (required&&!text) ? null : text;
}
export function parseQuote(body) {
  const scope=boundedText(body.scope,700,true),equipment=boundedText(body.equipment,400,true),exclusions=boundedText(body.exclusions,400);
  if(scope===null||equipment===null||exclusions===null)return {error:'quote',message:'Describe the included work and who brings the equipment. Keep the scope under 700 characters and equipment or exclusions under 400.'};
  const raw=Array.isArray(body.items)?body.items:Array.from({length:8},(_,i)=>({description:body['itemDescription'+i],amount:body['itemAmount'+i]})).filter(x=>String(x.description||'').trim()||String(x.amount||'').trim());
  if(!raw.length||raw.length>8)return {error:'quote',message:'Add 1–8 itemized prices.'};
  const items=[];
  for(const item of raw){
    if(!item||typeof item!=='object')return {error:'quote',message:'Each price needs a description and amount.'};
    const description=boundedText(item.description,120,true),amount=String(item.amount??'').trim();
    if(description===null||!/^\d{1,3}(?:\.\d{1,2})?$/.test(amount))return {error:'quote',message:'Each item needs a description under 120 characters and a dollar amount with at most two decimal places.'};
    const [whole,fraction='']=amount.split('.'),amountCents=Number(whole)*100+Number(fraction.padEnd(2,'0'));
    if(amountCents<0||amountCents>99900)return {error:'quote',message:'Each price must be from $0 to $999.'};
    items.push({description,amountCents});
  }
  const totalCents=items.reduce((sum,item)=>sum+item.amountCents,0);
  if(totalCents<=0||totalCents>99900)return {error:'quote',message:'The final total must be more than $0 and no more than $999.'};
  return {scope,equipment,exclusions,items,totalCents};
}
export function parseMessage(body) {
  const id=operationId(body.requestId),text=boundedText(body.text,1200,true);
  return !id||text===null?{error:'message',message:'Write a question or reply up to 1,200 characters, then send it from this page.'}:{id,text};
}
export function quoteMarkup(row,{parent=false,canQuote=false,requestId=''}={}) {
  if(row.kind==='inquiry')return '';
  const e=escapeNeighbor,action=e(parent?'/api/job/'+row.actionToken:'/api/booking/'+row.cancelToken),q=row.quote,accepted=quoteAccepted(row),terminal=['done','cancelled'].includes(row.status);
  let content='<section aria-labelledby="quote-heading"><h2 id="quote-heading">Job quote</h2>';
  if(q){
    content+=`<p><b>Revision ${Number(q.revision)} · ${accepted?'Accepted by the customer':'Waiting for customer acceptance'}</b></p><p>${e(q.scope).replace(/\n/g,'<br>')}</p><h3>Included prices</h3><ul>${q.items.map(item=>'<li>'+e(item.description)+' — '+money(item.amountCents)+'</li>').join('')}</ul><p><b>Final price per visit: ${money(q.totalCents)}</b></p><p><b>Equipment and supplies:</b> ${e(q.equipment).replace(/\n/g,'<br>')}</p><p><b>Not included:</b> ${q.exclusions?e(q.exclusions).replace(/\n/g,'<br>'):'Nothing beyond the work described above is included.'}</p>`;
    content+='<p>This is the complete agreed price for the described work, including any applicable charges. A changed quote needs fresh acceptance. Each approved repeating visit uses this per-visit price; accepting a quote does not approve a repeating schedule or confirm an appointment.</p>';
    if(!accepted&&!terminal)content+=parent?'<p><b>Wait for the customer to accept this revision before confirming, approving repeating visits, or marking the job done.</b></p>':`<form method="post" action="${action}"><input type="hidden" name="action" value="accept-quote"><input type="hidden" name="revision" value="${Number(q.revision)}"><label><input type="checkbox" name="accept" value="yes" required> I agree to the work, equipment arrangements, and final price of ${money(q.totalCents)} per visit in revision ${Number(q.revision)}.</label><button type="submit">Accept this quote</button></form>`;
    if(accepted)content+='<p>Price agreement is recorded. Appointment status is shown separately above.</p>';
  }else content+='<p>No separate quote has been sent. The parent can confirm the work and final price with you before the job.</p>';
  if(parent&&!terminal&&!canQuote)content+='<p>Online quote acceptance needs a customer email address. Agree on this phone-only request directly with the customer.</p>';
  if(parent&&!terminal&&canQuote){
    content+=`<details><summary>${q?'Revise this quote':'Send a clear quote'}</summary><form method="post" action="${action}"><input type="hidden" name="action" value="send-quote"><input type="hidden" name="requestId" value="${e(requestId)}"><input type="hidden" name="baseRevision" value="${Number(q?.revision||0)}"><label>Work included<textarea name="scope" maxlength="700" required>${e(q?.scope||row.service||'')}</textarea></label><label>Equipment and supplies — who brings what?<textarea name="equipment" maxlength="400" required>${e(q?.equipment||'')}</textarea></label><label>What is not included? (optional)<textarea name="exclusions" maxlength="400">${e(q?.exclusions||'')}</textarea></label><p>Itemize the complete final price in US dollars. Include any applicable charges. Empty rows are ignored.</p>${Array.from({length:8},(_,i)=>`<fieldset><legend>Price item ${i+1}</legend><label>Description<input type="text" name="itemDescription${i}" maxlength="120" value="${e(q?.items?.[i]?.description||'')}"${i===0?' required':''}></label><label>Amount ($)<input type="number" name="itemAmount${i}" min="0" max="999" step="0.01" value="${q?.items?.[i]?(q.items[i].amountCents/100).toFixed(2):''}"${i===0?' required':''}></label></fieldset>`).join('')}<p>Sending a revised quote replaces the current price agreement and requires the customer to accept again. Existing appointment times stay in place.</p><button type="submit">Send quote for acceptance</button></form></details>`;
  }
  return content+'</section>';
}
export function threadMarkup(row,{parent=false,requestId=''}={}) {
  const e=escapeNeighbor,action=e(parent?'/api/job/'+row.actionToken:'/api/booking/'+row.cancelToken),thread=Array.isArray(row.thread)?row.thread:[],closed=row.kind==='inquiry'&&row.status==='closed';
  return `<section aria-labelledby="questions-heading"><h2 id="questions-heading">Questions for the parent</h2><p>This conversation is private to this request. Messages do not change the price or appointment. Keep children’s personal contact details out of messages.</p>${thread.length?'<ol>'+thread.map(item=>'<li><p><b>'+(item.author==='parent'?'Parent':'Customer')+'</b> · <time datetime="'+e(item.at)+'">'+e(item.at.replace('T',' ').replace(/\.\d{3}Z$/,' UTC'))+'</time></p><p>'+e(item.text).replace(/\n/g,'<br>')+'</p></li>').join('')+'</ol>':'<p>No messages yet.</p>'}${closed?'<p>This question is closed. Visit the business page to start a new request.</p>':thread.length>=40?'<p>This conversation has reached its 40-message limit.</p>':`<form method="post" action="${action}"><input type="hidden" name="action" value="${parent?'reply':'question'}"><input type="hidden" name="requestId" value="${e(requestId)}"><label>${parent?'Reply to the customer':'Ask the parent'}<textarea name="text" maxlength="1200" required></textarea></label><button type="submit">${parent?'Send private reply':'Send question'}</button></form>`}</section>`;
}
