"""Parser for Tracks/trackN.trc. See web/spec-cit-trc.md"""
import struct,sys,os
def read_trc(path):
    d=open(path,'rb').read()
    hdr=d[:0x210]
    unk0,start_block,start_path=struct.unpack_from('<III',hdr,0)
    grid=[]
    for i in range(8):
        grid.append(struct.unpack_from('<16f',hdr,12+64*i))
    nseg=struct.unpack_from('<I',hdr,12+512)[0]
    segs=[struct.unpack_from('<II',d,0x210+8*i) for i in range(nseg)]
    end=0x210+8*nseg
    return dict(unk0=unk0,start_block=start_block,start_path=start_path,grid=grid,segs=segs,end=end,size=len(d))
if __name__=='__main__':
    G=sys.argv[1]
    for i in range(28):
        t=read_trc(os.path.join(G,'Tracks/track%d.trc'%i))
        assert t['end']==t['size'],(i,t['end'],t['size'])
        print(i,'start',t['start_block'],t['start_path'],'nseg',len(t['segs']),'unk0',hex(t['unk0']),'grid0',[round(x,1) for x in t['grid'][0][12:15]])
