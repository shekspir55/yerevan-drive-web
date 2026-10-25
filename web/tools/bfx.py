import struct,sys,os
def read_bfx(path):
    d=open(path,'rb').read()
    assert d[:4]==b'BFX1',path
    n=struct.unpack_from('<I',d,4)[0]
    out=[]
    for i in range(n):
        o=8+24*i
        name=d[o:o+16].split(b'\0')[0].decode('latin1')
        off,size=struct.unpack_from('<II',d,o+16)
        out.append((name,d[off:off+size]))
    return out
if __name__=='__main__':
    G=sys.argv[1]; O=sys.argv[2]
    for root,_,fs in os.walk(G):
        for f in fs:
            p=os.path.join(root,f)
            if f.lower().endswith(('.tex','.snd','.atx')) and open(p,'rb').read(4)==b'BFX1':
                items=read_bfx(p)
                rel=os.path.relpath(p,G).replace('/','_')
                od=os.path.join(O,rel); os.makedirs(od,exist_ok=True)
                for name,data in items: open(os.path.join(od,name),'wb').write(data)
                print(rel,len(items),sum(len(x[1]) for x in items))
