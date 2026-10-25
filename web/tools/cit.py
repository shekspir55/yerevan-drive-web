"""Parser for yerevan.cit (CIT1). See web/spec-cit-trc.md"""
import struct,sys
class R:
    def __init__(s,d,p=0): s.d=d; s.p=p
    def u32(s): v=struct.unpack_from('<I',s.d,s.p)[0]; s.p+=4; return v
    def u16(s): v=struct.unpack_from('<H',s.d,s.p)[0]; s.p+=2; return v
    def raw(s,n): v=s.d[s.p:s.p+n]; s.p+=n; return v
    def str16(s):
        n=s.u16(); return s.raw(n).decode('latin1')
def cstr(b): return b.split(b'\0')[0].decode('latin1')

def read_matlist(r):
    name=r.str16()
    cnt=r.u32(); unk=r.u32(); lname=cstr(r.raw(256))
    mats=[]
    for i in range(cnt):
        nm=r.str16(); m=r.raw(100)
        f=struct.unpack('<25f',m); u=struct.unpack('<25I',m)
        nst=u[20]&0xff
        stages=[]
        for j in range(nst):
            sd=r.raw(60); stages.append(dict(tex=cstr(sd[44:60]),raw=sd[:44]))
        mats.append(dict(name=nm,diffuse=f[2:6],ambient=f[6:10],specular=f[10:14],emissive=f[14:18],power=f[18],flags=m[0x4c:0x50],raw=m,stages=stages))
    return dict(name=name,count=cnt,unk=unk,listname=lname,mats=mats)

def read_sounddef(r):
    return dict(name=r.str16(),params=struct.unpack('<8I',r.raw(32)))
def read_mobjdef(r):
    name=r.str16(); p=struct.unpack('<9I',r.raw(36)); return dict(name=name,params=p,sound=read_sounddef(r))
def read_objdef(r):
    name=r.str16(); p=struct.unpack('<7I',r.raw(28)); return dict(name=name,params=p,sound=read_sounddef(r))
def read_list(r,fn):
    n=r.u32(); return [fn(r) for _ in range(n)]

def read_mesh(r):
    h=struct.unpack('<14I',r.raw(56))
    nv,nt,ns=h[1],h[2],h[3]
    verts=r.raw(nv*32); idx=r.raw(nt*6); subs=[struct.unpack('<5I',r.raw(20)) for _ in range(ns)]
    return dict(hdr=h,bbox=struct.unpack('<6f',struct.pack('<6I',*h[4:10])),nv=nv,nt=nt,verts=verts,idx=idx,subsets=subs)

def read_obj(r):
    b=r.raw(0x54)
    typ=struct.unpack_from('<I',b,0)[0]
    m=struct.unpack_from('<12f',b,4); pos=struct.unpack_from('<3f',b,52)
    rest=struct.unpack_from('<3I',b,64); by=b[76:84]
    return dict(type=typ,mat=m,pos=pos,a=rest[0],id=rest[1],b=rest[2],bytes=by,raw=b)

def read_coll(r):
    h=struct.unpack('<8I',r.raw(32)); nv,nt=h[0],h[1]
    return dict(nv=nv,nt=nt,h=h,bbox=struct.unpack('<6f',struct.pack('<6I',*h[2:8])),verts=struct.unpack('<%df'%(nv*3),r.raw(nv*12)),idx=struct.unpack('<%dH'%(nt*3),r.raw(nt*6)))

def read_path(r):
    a,npts,_p,b,c,n1,n2,_q=struct.unpack('<IHHIIBBH',r.raw(20))
    pts=struct.unpack('<%df'%(npts*3),r.raw(npts*12))
    l1=struct.unpack('<%dI'%n1,r.raw(n1*4)); l2=struct.unpack('<%dI'%n2,r.raw(n2*4))
    return dict(a=a,b=b,c=c,pts=pts,l1=l1,l2=l2)

def read_block(r):
    h=struct.unpack('<11I6H',r.raw(56))
    f=h[:11]; nA,nColl,nB,nobj,nPath,ndw=h[11:]
    blk=dict(f=f,counts=h[11:])
    blk['main']=read_mesh(r)
    blk['meshesA']=[read_mesh(r) for _ in range(nA)]
    blk['meshesB']=[read_mesh(r) for _ in range(nB)]
    blk['objs']=[read_obj(r) for _ in range(nobj)]
    blk['colls']=[read_coll(r) for _ in range(nColl)]
    blk['paths']=[read_path(r) for _ in range(nPath)]
    blk['dw']=struct.unpack('<%dI'%ndw,r.raw(ndw*4))
    return blk

def read_cit(path):
    d=open(path,'rb').read()
    r=R(d)
    hdr=r.raw(0x90)
    assert hdr[:4]==b'CIT1'
    nblocks=struct.unpack_from('<I',hdr,0x8c)[0]
    out=dict(title=cstr(hdr[8:]),nblocks=nblocks)
    out['matlists']=[read_matlist(r) for _ in range(3)]
    out['sounds']=read_list(r,read_sounddef)
    out['mobjdefs']=read_list(r,read_mobjdef)
    out['objdefs']=read_list(r,read_objdef)
    out['plakdefs']=read_list(r,read_objdef)
    out['blocks']=[read_block(r) for _ in range(nblocks)]
    n=r.u32()
    out['tail']=[r.raw(0x44) for _ in range(n)]
    out['end']=r.p; out['size']=len(d)
    return out

def fl(u): return struct.unpack('<f',struct.pack('<I',u))[0]
def block_aabb(b): return [fl(x) for x in b['f'][1:7]]      # min xyz, max xyz
def block_sphere(b): return [fl(x) for x in b['f'][7:11]]   # cx,cy,cz,r
def resolve_link(blocks,bi,val):
    """path link u32 -> (block index, path index)"""
    lo,hi=val&0xffff,val>>16
    return (bi if lo==0 else blocks[bi]['dw'][lo-1]),hi

def summary(c):
    import collections
    print('title %r blocks %d  end %d / size %d'%(c['title'],c['nblocks'],c['end'],c['size']))
    for i,m in enumerate(c['matlists']): print(' matlist%d %s: %d materials'%(i,m['listname'],m['count']))
    print(' sounds',len(c['sounds']),'mobjdefs',len(c['mobjdefs']),'objdefs',len(c['objdefs']),'plakdefs',len(c['plakdefs']),'spawn slots',len(c['tail']))
    ab=[block_aabb(b) for b in c['blocks']]
    print(' world AABB x[%.0f..%.0f] y[%.0f..%.0f] z[%.0f..%.0f]'%(min(a[0] for a in ab),max(a[3] for a in ab),min(a[1] for a in ab),max(a[4] for a in ab),min(a[2] for a in ab),max(a[5] for a in ab)))
    tc=collections.Counter(o['type'] for b in c['blocks'] for o in b['objs'])
    print(' object records by type',dict(sorted(tc.items())))
    print(' meshes',sum(1+len(b['meshesA'])+len(b['meshesB']) for b in c['blocks']),'verts',sum(m['nv'] for b in c['blocks'] for m in [b['main']]+b['meshesA']+b['meshesB']),
          'collision meshes',sum(len(b['colls']) for b in c['blocks']),'paths',sum(len(b['paths']) for b in c['blocks']))
    print(' objdefs:',[d['name'] for d in c['objdefs']])
    print(' mobjdefs:',[d['name'] for d in c['mobjdefs']])
    print(' plakdefs:',[d['name'] for d in c['plakdefs']])
    print(' sounds:',[d['name'] for d in c['sounds']])

if __name__=='__main__':
    c=read_cit(sys.argv[1])
    assert c['end']==c['size']
    summary(c)
