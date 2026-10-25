"""Private routing gate: bounded authenticated GETs; never logs coordinates or tokens."""
import os
import http.server,urllib.request,urllib.error,urllib.parse,json,hmac,time,threading,math
from pathlib import Path
ROOT=Path(os.environ.get('PLANROUTE_ROOT','/srv/planificator-routing'))
TOKEN=(ROOT/'token').read_text().strip()
if len(TOKEN)<32:raise RuntimeError('Routing credential missing')
slots=threading.BoundedSemaphore(2)
lock=threading.Lock();last=0.0
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def reply(self,status,body,kind='application/json'):
  self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
 def do_GET(self):
  global last
  if not hmac.compare_digest(self.headers.get('Authorization',''), 'Bearer '+TOKEN):return self.reply(401,b'{"code":"UNAUTHORIZED"}')
  p=urllib.parse.urlsplit(self.path)
  if p.path=='/health' and not p.query:
   try:
    with urllib.request.urlopen('http://127.0.0.1:8989/info',timeout=2) as r:d=json.load(r)
    if d.get('version')!='11.1':raise RuntimeError('Unexpected engine')
    return self.reply(200,json.dumps({'status':'ok','engine':'GraphHopper '+d['version'],'graphVersion':(ROOT/'graph-version').read_text().strip(),'profiles':[x['name'] for x in d['profiles']]}).encode())
   except Exception:return self.reply(503,b'{"code":"UNAVAILABLE"}')
  if p.path!='/route' or len(self.path)>6000:return self.reply(404,b'{"code":"NOT_FOUND"}')
  q=urllib.parse.parse_qs(p.query,keep_blank_values=True)
  fixed={'profile':['car'],'instructions':['false'],'calc_points':['true'],'points_encoded':['false'],'details':['leg_distance'],'elevation':['false'],'way_point_max_distance':['1000000']}
  if set(q)!=set(fixed)|{'point'} or any(q[k]!=v for k,v in fixed.items()) or not 2<=len(q.get('point',[]))<=40:return self.reply(400,b'{"code":"INVALID_REQUEST"}')
  try:
   for point in q['point']:
    lat,lon=map(float,point.split(','))
    if not math.isfinite(lat+lon) or not -90<=lat<=90 or not -180<=lon<=180:raise ValueError()
  except Exception:return self.reply(400,b'{"code":"INVALID_POINT"}')
  with lock:
   now=time.monotonic()
   if now-last<0.5:return self.reply(429,b'{"code":"BUSY"}')
   last=now
  if not slots.acquire(blocking=False):return self.reply(429,b'{"code":"BUSY"}')
  try:
   with urllib.request.urlopen('http://127.0.0.1:8989'+self.path,timeout=5) as r:
    body=r.read(100001)
    if len(body)>100000:return self.reply(502,b'{"code":"RESPONSE_LIMIT"}')
    return self.reply(200,body)
  except urllib.error.HTTPError as e:return self.reply(400 if e.code==400 else 503,b'{"code":"ROUTE_NOT_FOUND"}')
  except Exception:return self.reply(503,b'{"code":"UNAVAILABLE"}')
  finally:slots.release()
 def do_POST(self):return self.reply(405,b'{"code":"METHOD_NOT_ALLOWED"}')
http.server.ThreadingHTTPServer(('127.0.0.1',8992),Handler).serve_forever()
