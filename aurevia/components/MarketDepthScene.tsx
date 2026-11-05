'use client';

import {Canvas,useFrame,useThree} from '@react-three/fiber';
import {useMemo,useRef} from 'react';
import {ExtrudeGeometry,Path,Shape} from 'three';
import type {Group} from 'three';
import {useTheme} from '@/lib/theme-context';

function AureviaEmblem({premium}:{premium:boolean}){
	const emblem=useRef<Group>(null);
	const geometry=useMemo(()=>{
		const shape=new Shape();
		shape.moveTo(-1,-1);
		shape.lineTo(-.18,1);
		shape.lineTo(.18,1);
		shape.lineTo(1,-1);
		shape.lineTo(.56,-1);
		shape.lineTo(.38,-.52);
		shape.lineTo(-.38,-.52);
		shape.lineTo(-.56,-1);
		shape.closePath();
		const arrow=new Path();
		arrow.moveTo(0,.58);
		arrow.lineTo(.34,.18);
		arrow.lineTo(.14,.18);
		arrow.lineTo(.14,-.32);
		arrow.lineTo(-.14,-.32);
		arrow.lineTo(-.14,.18);
		arrow.lineTo(-.34,.18);
		arrow.closePath();
		shape.holes.push(arrow);
		return new ExtrudeGeometry(shape,{depth:.12,bevelEnabled:true,bevelSegments:2,steps:1,bevelSize:.045,bevelThickness:.04,curveSegments:2});
	},[]);

	useFrame((state,delta)=>{
		if(!emblem.current)return;
		emblem.current.rotation.y+=delta*.12;
		emblem.current.rotation.x+=(state.pointer.y*.1-emblem.current.rotation.x)*Math.min(1,delta*1.5);
		emblem.current.rotation.z+=(-state.pointer.x*.08-emblem.current.rotation.z)*Math.min(1,delta*1.5);
	});

	return <group ref={emblem} position={[0,0,.2]}>
		<mesh geometry={geometry} castShadow receiveShadow>
			<meshPhysicalMaterial color={premium?'#9c7945':'#e2c47f'} emissive={premium?'#593d1a':'#754d14'} emissiveIntensity={.36} metalness={.58} roughness={.24} clearcoat={.55} clearcoatRoughness={.28}/>
		</mesh>
		<mesh rotation={[.72,.2,.16]}>
			<torusGeometry args={[1.62,.012,5,96]}/>
			<meshBasicMaterial color={premium?'#9c7945':'#e0c99e'} transparent opacity={.42}/>
		</mesh>
		<mesh rotation={[1.16,-.42,.45]}>
			<torusGeometry args={[1.8,.008,4,96]}/>
			<meshBasicMaterial color={premium?'#527887':'#91b6a0'} transparent opacity={.3}/>
		</mesh>
	</group>;
}

function MarketModel({premium}:{premium:boolean}){
	const model=useRef<Group>(null);
	const {viewport}=useThree();
	const nodes=useMemo(()=>Array.from({length:24},(_,index)=>{
		const fraction=(index+.5)/24;
		const inclination=Math.acos(1-2*fraction);
		const azimuth=Math.PI*(3-Math.sqrt(5))*index;
		const radius=2.2;
		return [radius*Math.sin(inclination)*Math.cos(azimuth),radius*Math.cos(inclination),radius*Math.sin(inclination)*Math.sin(azimuth)] as [number,number,number];
	}),[]);
	const compact=viewport.width<7;
	const baseY=compact?.85:.15;

	useFrame((state,delta)=>{
		if(!model.current)return;
		model.current.rotation.y+=delta*.035;
		model.current.rotation.x=Math.sin(state.clock.elapsedTime*.08)*.025;
		model.current.position.y=baseY+Math.sin(state.clock.elapsedTime*.35)*.035;
	});

	return <group ref={model} position={[viewport.width*(compact?.48:.45),baseY,-1.5]} scale={compact?.58:.72}>
		<AureviaEmblem premium={premium}/>
		{nodes.map((position,index)=><mesh position={position} key={index}>
			<sphereGeometry args={[index%5===0?.045:.026,8,8]}/>
			<meshBasicMaterial color={index%5===0?(premium?'#9c7945':'#e0c99e'):(premium?'#16865b':'#8fb39a')} transparent opacity={index%5===0?.72:.48} depthWrite={false}/>
		</mesh>)}
	</group>;
}

export default function MarketDepthScene({className=''}:{className?:string}){
	const {theme}=useTheme();
	const premium=theme==='premium-dashboard';
	return <Canvas
		className={`market-depth-canvas ${className}`}
		aria-hidden="true"
		dpr={[1,1.25]}
		camera={{position:[0,0,10],fov:37}}
		gl={{alpha:true,antialias:false,powerPreference:'low-power'}}
		fallback={<div className={`market-depth-fallback ${className}`} aria-hidden="true"><span className="market-depth-fallback-mark">A<i>↑</i></span></div>}>
		<ambientLight intensity={.48}/>
		<pointLight position={[2,3,5]} intensity={3.5} color={premium?'#9c7945':'#f0d596'}/>
		<pointLight position={[-4,-2,3]} intensity={1.4} color={premium?'#527887':'#5e9d76'}/>
		<MarketModel premium={premium}/>
	</Canvas>;
}
