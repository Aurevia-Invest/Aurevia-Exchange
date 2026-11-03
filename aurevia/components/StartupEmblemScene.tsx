'use client';

import {Canvas,useFrame,useThree} from '@react-three/fiber';
import {useEffect,useMemo,useRef,useState} from 'react';
import {Object3D} from 'three';
import type {Group,InstancedMesh} from 'three';

type EmblemParticle={
	x:number;
	y:number;
	z:number;
	startX:number;
	startY:number;
	startZ:number;
	delay:number;
	duration:number;
	size:number;
};

function EmblemParticles(){
	const mesh=useRef<InstancedMesh>(null);
	const formation=useRef<Group>(null);
	const dummy=useMemo(()=>new Object3D(),[]);
	const {size}=useThree();
	const particleCount=size.width<600?360:680;
	const [particles,setParticles]=useState<EmblemParticle[]>([]);

	useEffect(()=>{
		let cancelled=false;
		const image=new window.Image();
		image.decoding='async';
		image.onload=()=>{
			const sampleSize=144;
			const sampleCanvas=document.createElement('canvas');
			sampleCanvas.width=sampleSize;
			sampleCanvas.height=sampleSize;
			const context=sampleCanvas.getContext('2d',{willReadFrequently:true});
			if(!context)return;
			context.drawImage(image,0,0,sampleSize,sampleSize);
			const data=context.getImageData(0,0,sampleSize,sampleSize).data;
			const visiblePixels:number[]=[];
			for(let pixel=0;pixel<sampleSize*sampleSize;pixel++){
				if(data[pixel*4+3]>100)visiblePixels.push(pixel);
			}
			if(!visiblePixels.length)return;

			let seed=0x41555245;
			const random=()=>{
				seed=(seed*1664525+1013904223)>>>0;
				return seed/0x100000000;
			};
			const nextParticles=Array.from({length:particleCount},()=>{
				const pixel=visiblePixels[Math.floor(random()*visiblePixels.length)];
				const x=pixel%sampleSize;
				const y=Math.floor(pixel/sampleSize);
				return {
					x:(x/sampleSize-.5)*3.1,
					y:(.5-y/sampleSize)*3.1,
					z:(random()-.5)*.035,
					startX:(random()-.5)*7.5,
					startY:(random()-.5)*5.5,
					startZ:(random()-.5)*4,
					delay:random()*1.1,
					duration:1.75+random()*.3,
					size:.68+random()*.64,
				};
			});
			if(!cancelled)setParticles(nextParticles);
		};
		image.src='/aurevia-logo.png';
		return()=>{
			cancelled=true;
			image.onload=null;
		};
	},[particleCount]);

	useFrame(({clock,viewport})=>{
		const instance=mesh.current;
		const group=formation.current;
		if(!instance||!group||!particles.length)return;
		const elapsed=clock.elapsedTime;
		group.scale.setScalar(Math.min(1,viewport.width/4));
		group.position.y=size.height<620?1.2:.82;
		group.rotation.y=Math.sin(elapsed*.34)*.055;
		group.rotation.x=Math.sin(elapsed*.26)*.025;
		for(let index=0;index<particles.length;index++){
			const particle=particles[index];
			const progress=Math.min(1,Math.max(0,(elapsed-particle.delay)/particle.duration));
			const eased=1-Math.pow(1-progress,3);
			const scale=Math.min(1,progress*2.4)*particle.size;
			dummy.position.set(
				particle.startX+(particle.x-particle.startX)*eased,
				particle.startY+(particle.y-particle.startY)*eased,
				particle.startZ+(particle.z-particle.startZ)*eased,
			);
			dummy.scale.setScalar(scale);
			dummy.rotation.set(0,0,0);
			dummy.updateMatrix();
			instance.setMatrixAt(index,dummy.matrix);
		}
		instance.instanceMatrix.needsUpdate=true;
	});

	return <group ref={formation} position={[0,.82,0]}>
		<instancedMesh ref={mesh} args={[undefined,undefined,particles.length]} frustumCulled={false}>
			<sphereGeometry args={[size.width<600?.019:.013,8,8]}/>
			<meshPhysicalMaterial color="#d9b66f" metalness={.72} roughness={.22} clearcoat={.75} clearcoatRoughness={.2} emissive="#6c4712" emissiveIntensity={.08}/>
		</instancedMesh>
	</group>;
}

export default function StartupEmblemScene(){
	return <Canvas
		className="intro-particle-canvas"
		aria-hidden="true"
		dpr={1}
		camera={{position:[0,0,9],fov:36}}
		gl={{alpha:true,antialias:false,powerPreference:'low-power'}}
		fallback={<div className="intro-webgl-fallback"/>}>
		<ambientLight intensity={.82}/>
		<pointLight position={[3,4,5]} intensity={5.5} color="#ffe7ad"/>
		<pointLight position={[-3,-1,3]} intensity={3.1} color="#a9823d"/>
		<directionalLight position={[-2,3,4]} intensity={1.8} color="#fff4d8"/>
		<EmblemParticles/>
	</Canvas>;
}
