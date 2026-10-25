import struct,sys
class Node:
    __slots__=('type','name','data','kids')
def parse(d,pos=0):
    t,nl,dl,nc=struct.unpack_from('<4I',d,pos); pos+=16
    n=Node(); n.type=t
    n.name=d[pos:pos+nl].split(b'\0')[0].decode('latin1'); pos+=nl
    n.data=d[pos:pos+dl]; pos+=dl
    n.kids=[]
    for _ in range(nc):
        k,pos=parse(d,pos); n.kids.append(k)
    return n,pos
def dump(n,ind=0,maxd=99):
    print('  '*ind+f'type={n.type:#x} name={n.name!r} data={len(n.data)} kids={len(n.kids)}')
    if ind<maxd:
        for k in n.kids: dump(k,ind+1,maxd)
if __name__=='__main__':
    d=open(sys.argv[1],'rb').read()
    r,p=parse(d); print('end',p,'of',len(d))
    dump(r,0,int(sys.argv[2]) if len(sys.argv)>2 else 99)
