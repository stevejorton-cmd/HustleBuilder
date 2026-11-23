import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../index.html',import.meta.url),'utf8');
const part=(from,to)=>{
  const start=source.indexOf(from),end=source.indexOf(to,start+from.length);
  assert.ok(start>=0&&end>start,from);
  return source.slice(start,end);
};
const datasetKey=name=>name.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());

function harness(){
  let now=Date.parse('2026-11-22T18:30:00Z');
  const nodes=[],intervals=[];
  const context=vm.createContext({
    Date:{now:()=>now},B:{upcoming:[{id:'manual-job',date:'2026-11-22',customer:'Neighbor',service:'Raking',status:'working',startedAt:now-90_000}]},
    todayISO:()=> '2026-11-22',sortSched:()=>0,parseISO:value=>new Date(value+'T12:00:00Z'),
    esc:value=>String(value??''),money:value=>'$'+value,fmtTime:value=>value,addrLink:()=>'',dirAnchor:()=>'',digitsOf:()=>'',
    document:{querySelectorAll(selector){
      const attribute=selector.match(/^\[data-([a-z-]+)\]$/);
      assert.ok(attribute,'timer uses a dedicated data attribute');
      const key=datasetKey(attribute[1]);
      return nodes.filter(node=>Object.hasOwn(node.dataset,key));
    }},
    setInterval(callback,delay){intervals.push({callback,delay});return intervals.length;}
  });
  vm.runInContext(source.match(/^const pad=.*$/m)[0]+'\n'+part('function elapsed(ms){','function fmtTime(')+part('function todayHTML(){','let ticker=null;')+part('let ticker=null;','// Opening Messages only prepares a request;'),context);
  return {context,nodes,intervals,advance(ms){now+=ms;}};
}

test('the real manual-job timer advances without overwriting recurring or reschedule controls',()=>{
  const h=harness(),html=h.context.todayHTML();
  // Build the timer node from the actual rendered manual-job markup. This
  // catches either side of the renderer/consumer attribute contract drifting.
  const timerMarkup=html.match(/<b data-([a-z-]+)="([^"]+)">([^<]*)<\/b>/);
  assert.ok(timerMarkup,'a working manual job renders its elapsed timer');
  const timer={dataset:{[datasetKey(timerMarkup[1])]:timerMarkup[2]},textContent:timerMarkup[3]};
  assert.equal(timer.textContent,'0:01');
  const controls=['Approve repeating visits','Accept new time','Keep original time'].map(textContent=>({dataset:{start:'2026-12-02T16:00'},textContent}));
  const original=structuredClone(controls);h.nodes.push(timer,...controls);
  h.context.startTicker();h.context.startTicker();assert.equal(h.intervals.length,1,'repeated renders do not create another ticker');
  assert.equal(h.intervals[0].delay,15000);
  h.advance(30_000);h.intervals[0].callback();
  assert.equal(timer.textContent,'0:02');
  assert.deepEqual(controls,original,'booking labels and appointment start values stay unchanged');
});

test('the real timer callback skips nonfinite timestamps and continues updating valid timers',()=>{
  const h=harness(),invalid=['not-a-number','Infinity','2026-12-02T16:00'].map(elapsedStart=>({dataset:{elapsedStart},textContent:'Waiting'}));
  const valid={dataset:{elapsedStart:String(Date.parse('2026-11-22T17:00:00Z'))},textContent:'Previous'};
  h.nodes.push(...invalid,valid);h.context.startTicker();h.intervals[0].callback();
  for(const node of invalid)assert.equal(node.textContent,'Waiting');
  assert.equal(valid.textContent,'1:30');
});
