import * as THREE from "three";
import { Client, Room, getStateCallbacks } from "colyseus.js";

interface TelegramWebApp {
  ready?: () => void;
  expand?: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  disableVerticalSwipes?: () => void;
  isVerticalSwipesEnabled?: boolean;
  requestFullscreen?: () => void;
  lockOrientation?: (orientation: "portrait" | "landscape") => void;
  isClosingConfirmationEnabled?: boolean;
  enableClosingConfirmation?: () => void;
}
const tg = (
  window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }
).Telegram?.WebApp;
if (tg) {
  tg.ready?.();
  tg.expand?.();
  tg.setHeaderColor?.("#0b0d12");
  tg.setBackgroundColor?.("#0b0d12");
  tg.disableVerticalSwipes?.();
}

function goFullscreenLandscape() {
  try {
    tg?.requestFullscreen?.();
  } catch {
    // ignore
  }
  try {
    tg?.lockOrientation?.("landscape");
  } catch {
    // ignore
  }
  const orient = (
    screen as unknown as {
      orientation?: { lock?: (o: string) => Promise<void> };
    }
  ).orientation;
  if (orient?.lock) {
    orient.lock("landscape").catch(() => {});
  }
  const docEl = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void>;
  };
  if (!document.fullscreenElement) {
    try {
      (docEl.requestFullscreen?.() ?? docEl.webkitRequestFullscreen?.())
        ?.catch?.(() => {});
    } catch {
      // ignore
    }
  }
}
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const canvas = document.getElementById("app") as HTMLCanvasElement;
const statusEl = document.getElementById("status") as HTMLDivElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);
scene.fog = new THREE.Fog(0x0b0d12, 25, 70);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  200
);
const CAM_OFFSET = new THREE.Vector3(12, 14, 12);

const pmremGen = new THREE.PMREMGenerator(renderer);
scene.environment = pmremGen.fromScene(new RoomEnvironment(), 0.04).texture;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.55,
  0.4,
  0.92
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

scene.add(new THREE.AmbientLight(0xaabbcc, 0.7));
const sun = new THREE.DirectionalLight(0xfff2d0, 2.6);
sun.position.set(15, 25, 10);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -30;
sun.shadow.camera.right = 30;
sun.shadow.camera.top = 30;
sun.shadow.camera.bottom = -30;
sun.shadow.camera.near = 0.1;
sun.shadow.camera.far = 80;
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 80),
  new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.95 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(80, 40, 0x3a4252, 0x1f2530);
const gridMat = grid.material as THREE.Material;
gridMat.transparent = true;
gridMat.opacity = 0.45;
scene.add(grid);

interface PlayerView {
  group: THREE.Group;
  body: THREE.Mesh;
  bodyMat: THREE.MeshStandardMaterial;
  hpBarFg: THREE.Mesh;
  hpBarGroup: THREE.Group;
  coneOutline: THREE.LineLoop | null;
  stunAura: THREE.Mesh;
  mixer: THREE.AnimationMixer | null;
  idleAction: THREE.AnimationAction | null;
  runAction: THREE.AnimationAction | null;
  deathAction: THREE.AnimationAction | null;
  attackAction: THREE.AnimationAction | null;
  whirlwindAction: THREE.AnimationAction | null;
  attackingUntil: number;
  avatar: THREE.Object3D | null;
  spineBone: THREE.Object3D | null;
  aoeSpinStart: number;
  aoeSpinUntil: number;
  bladeTip: THREE.Object3D | null;
  target: THREE.Vector3;
  targetRotY: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  flashUntil: number;
  attackScaleUntil: number;
  stunnedUntil: number;
  slowedUntil: number;
  riftHideUntil: number;
  lastPos: THREE.Vector3;
}

const AUTO_CONE_RANGE = 4.0;
const AUTO_CONE_HALF = Math.PI / 6;

function buildConeGeometry(
  range: number,
  halfAngle: number,
  segs = 32
): THREE.BufferGeometry {
  const verts: number[] = [0, 0, 0];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = -halfAngle + t * 2 * halfAngle;
    verts.push(Math.sin(a) * range, 0, Math.cos(a) * range);
  }
  const idx: number[] = [];
  for (let i = 1; i <= segs; i++) idx.push(0, i, i + 1);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geom.setIndex(idx);
  geom.computeVertexNormals();
  return geom;
}

const coneGeom = buildConeGeometry(AUTO_CONE_RANGE, AUTO_CONE_HALF);

function buildConeOutlineGeometry(
  range: number,
  halfAngle: number,
  segs = 32
): THREE.BufferGeometry {
  const verts: number[] = [0, 0, 0];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = -halfAngle + t * 2 * halfAngle;
    verts.push(Math.sin(a) * range, 0, Math.cos(a) * range);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  return geom;
}

const coneOutlineGeom = buildConeOutlineGeometry(
  AUTO_CONE_RANGE,
  AUTO_CONE_HALF
);
const coneOutlineMat = new THREE.LineBasicMaterial({
  color: 0xff2233,
  transparent: true,
  opacity: 0.7,
  depthTest: false,
});

interface PlayerSchema {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  rotationY: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  stunnedUntil: number;
  slowedUntil: number;
  wins: number;
}

const CHARACTER_SCALE = 0.01;
let baseRig: THREE.Object3D | null = null;
let idleClip: THREE.AnimationClip | null = null;
let runClip: THREE.AnimationClip | null = null;
let deathClip: THREE.AnimationClip | null = null;
let attackClip: THREE.AnimationClip | null = null;
let whirlwindClip: THREE.AnimationClip | null = null;
let scytheTemplate: THREE.Object3D | null = null;
let vortexTexture: THREE.Texture | null = null;
const VORTEX_COLS = 6;
const VORTEX_ROWS = 4;
let riftTexture: THREE.Texture | null = null;
const RIFT_COLS = 4;
const RIFT_ROWS = 4;
const RIFT_FRAMES = 16;
let impactTexture: THREE.Texture | null = null;
const IMPACT_COLS = 4;
const IMPACT_ROWS = 4;
const IMPACT_FRAMES = 16;
let chainTexture: THREE.Texture | null = null;
const CHAIN_COLS = 4;
const CHAIN_ROWS = 4;
const CHAIN_FRAMES = 16;
let slashTexture: THREE.Texture | null = null;
const SLASH_COLS = 4;
const SLASH_ROWS = 4;
const SLASH_FRAMES = 16;

const LOWER_BODY_KEYWORDS = ["Hips", "UpLeg", "Leg", "Foot", "Toe"];
function filterUpperBodyOnly(clip: THREE.AnimationClip) {
  clip.tracks = clip.tracks.filter(
    (t) => !LOWER_BODY_KEYWORDS.some((k) => t.name.includes(k))
  );
}

const RIGHT_ARM_KEYWORDS = ["Shoulder", "Arm", "Hand"];
function filterRightArmOnly(clip: THREE.AnimationClip) {
  clip.tracks = clip.tracks.filter((t) => {
    if (!t.name.includes("Right")) return false;
    return RIGHT_ARM_KEYWORDS.some((k) => t.name.includes(k));
  });
}

function filterTorsoAndRightArm(clip: THREE.AnimationClip) {
  clip.tracks = clip.tracks.filter((t) => {
    if (LOWER_BODY_KEYWORDS.some((k) => t.name.includes(k))) return false;
    if (t.name.includes("Left")) return false;
    return true;
  });
}

const SCYTHE_SCALE = 100;
const SCYTHE_POS = new THREE.Vector3(-10, -30, 0);
const SCYTHE_ROT = new THREE.Euler(0, 0, 0);
const BLADE_TIP_OFFSET = new THREE.Vector3(0, 1.8, 0);

function makeSoftCircleTexture(): THREE.CanvasTexture {
  const size = 64;
  const cvs = document.createElement("canvas");
  cvs.width = size;
  cvs.height = size;
  const ctx = cvs.getContext("2d")!;
  const grad = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2
  );
  grad.addColorStop(0, "rgba(120,200,255,1)");
  grad.addColorStop(0.4, "rgba(60,160,255,0.6)");
  grad.addColorStop(1, "rgba(30,100,200,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const trailTexture = makeSoftCircleTexture();

function makeEnergyStreakTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 128;
  const cvs = document.createElement("canvas");
  cvs.width = w;
  cvs.height = h;
  const ctx = cvs.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 80; i++) {
    const x = Math.random() * w;
    const streakW = 2 + Math.random() * 14;
    const alpha = 0.25 + Math.random() * 0.75;
    const yTop = Math.random() * h * 0.4;
    const yBot = h - Math.random() * h * 0.3;
    const grad = ctx.createLinearGradient(x, yTop, x, yBot);
    grad.addColorStop(0, `rgba(100,200,255,0)`);
    grad.addColorStop(0.5, `rgba(180,230,255,${alpha})`);
    grad.addColorStop(1, `rgba(100,200,255,0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(x, yTop, streakW, yBot - yTop);
  }
  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(2, 1);
  return tex;
}
const energyStreakTexture = makeEnergyStreakTexture();

function makeSwirlGroundTexture(): THREE.CanvasTexture {
  const size = 512;
  const cvs = document.createElement("canvas");
  cvs.width = size;
  cvs.height = size;
  const ctx = cvs.getContext("2d")!;
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  const rMax = size / 2;
  const img = ctx.getImageData(0, 0, size, size);
  const data = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r > rMax) continue;
      const rn = r / rMax;
      const ang = Math.atan2(dy, dx);
      const swirl = Math.sin(ang * 6 + rn * 9) * 0.5 + 0.5;
      const radial = 1 - rn;
      const inner = Math.pow(1 - rn, 2);
      const intensity = inner * 0.6 + swirl * radial * 0.8;
      const i = (y * size + x) * 4;
      data[i] = 80 * intensity;
      data[i + 1] = 180 * intensity;
      data[i + 2] = 255 * intensity;
      data[i + 3] = 255 * intensity;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const swirlGroundTexture = makeSwirlGroundTexture();

function findBoneBySuffix(
  root: THREE.Object3D,
  suffix: string
): THREE.Object3D | null {
  const lower = suffix.toLowerCase();
  let found: THREE.Object3D | null = null;
  root.traverse((obj) => {
    if (found) return;
    if (obj.name.toLowerCase().endsWith(lower)) found = obj;
  });
  return found;
}

function stripRootMotion(clip: THREE.AnimationClip) {
  clip.tracks = clip.tracks.filter((track) => {
    const isHipsPos =
      track.name.endsWith(".position") &&
      /hips/i.test(track.name);
    return !isHipsPos;
  });
}

async function loadCharacterAssets() {
  const fbxLoader = new FBXLoader();
  const gltfLoader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const [
    idleFbx,
    runFbx,
    deathFbx,
    attackFbx,
    whirlwindFbx,
    gltf,
    scytheGltf,
    vortexTex,
    riftTex,
    impactTex,
    chainTex,
    slashTex,
  ] = await Promise.all([
    fbxLoader.loadAsync("/character/idle.fbx"),
    fbxLoader.loadAsync("/character/run.fbx"),
    fbxLoader.loadAsync("/character/death.fbx"),
    fbxLoader.loadAsync("/character/attack.fbx"),
    fbxLoader.loadAsync("/character/whirlwind.fbx"),
    gltfLoader.loadAsync("/character/warrior.glb"),
    gltfLoader.loadAsync("/character/scythe.glb"),
    texLoader.loadAsync("/vfx/vortex.png"),
    texLoader.loadAsync("/vfx/rift.png"),
    texLoader.loadAsync("/vfx/impact.png"),
    texLoader.loadAsync("/vfx/chain.png"),
    texLoader.loadAsync("/vfx/slash.png"),
  ]);
  vortexTex.colorSpace = THREE.SRGBColorSpace;
  vortexTex.magFilter = THREE.LinearFilter;
  vortexTex.minFilter = THREE.LinearFilter;
  vortexTexture = vortexTex;
  riftTex.colorSpace = THREE.SRGBColorSpace;
  riftTex.magFilter = THREE.LinearFilter;
  riftTex.minFilter = THREE.LinearFilter;
  riftTexture = riftTex;
  impactTex.colorSpace = THREE.SRGBColorSpace;
  impactTex.magFilter = THREE.LinearFilter;
  impactTex.minFilter = THREE.LinearFilter;
  impactTexture = impactTex;
  chainTex.colorSpace = THREE.SRGBColorSpace;
  chainTex.magFilter = THREE.LinearFilter;
  chainTex.minFilter = THREE.LinearFilter;
  chainTexture = chainTex;
  slashTex.colorSpace = THREE.SRGBColorSpace;
  slashTex.magFilter = THREE.LinearFilter;
  slashTex.minFilter = THREE.LinearFilter;
  slashTexture = slashTex;

  scytheTemplate = scytheGltf.scene;
  scytheTemplate.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (m.isMesh) {
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
    }
  });

  idleClip = idleFbx.animations[0] ?? null;
  runClip = runFbx.animations[0] ?? null;
  deathClip = deathFbx.animations[0] ?? null;
  if (idleClip) {
    idleClip.name = "idle";
    stripRootMotion(idleClip);
  }
  if (runClip) {
    runClip.name = "run";
    stripRootMotion(runClip);
  }
  if (deathClip) {
    deathClip.name = "death";
    stripRootMotion(deathClip);
  }

  attackClip = attackFbx.animations[0] ?? null;
  if (attackClip) {
    attackClip.name = "attack";
    const tracksBefore = attackClip.tracks.length;
    stripRootMotion(attackClip);
    filterTorsoAndRightArm(attackClip);
    console.log(
      `[attack] clip duration=${attackClip.duration}s, tracks ${tracksBefore}→${attackClip.tracks.length} (torso + right arm)`
    );
  }

  whirlwindClip = whirlwindFbx.animations[0] ?? null;
  if (whirlwindClip) {
    whirlwindClip.name = "whirlwind";
    const tracksBefore = whirlwindClip.tracks.length;
    stripRootMotion(whirlwindClip);
    filterUpperBodyOnly(whirlwindClip);
    console.log(
      `[whirlwind] clip duration=${whirlwindClip.duration}s, tracks ${tracksBefore}→${whirlwindClip.tracks.length} (upper body)`
    );
  }

  const fbxSkinneds: THREE.SkinnedMesh[] = [];
  idleFbx.traverse((obj) => {
    const m = obj as THREE.SkinnedMesh;
    if (m.isSkinnedMesh) fbxSkinneds.push(m);
  });

  const gltfMeshes: THREE.Mesh[] = [];
  gltf.scene.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (m.isMesh) gltfMeshes.push(m);
  });

  const upgradeMat = (mat: THREE.Material): THREE.Material => {
    if ((mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
      const s = mat as THREE.MeshStandardMaterial;
      if (s.map) s.map.colorSpace = THREE.SRGBColorSpace;
      if (s.emissiveMap) s.emissiveMap.colorSpace = THREE.SRGBColorSpace;
      return s;
    }
    if ((mat as THREE.MeshPhongMaterial).isMeshPhongMaterial) {
      const p = mat as THREE.MeshPhongMaterial;
      const s = new THREE.MeshStandardMaterial({
        color: p.color,
        map: p.map ?? null,
        normalMap: p.normalMap ?? null,
        roughness: 0.75,
        metalness: 0.0,
      });
      if (s.map) s.map.colorSpace = THREE.SRGBColorSpace;
      return s;
    }
    return mat;
  };

  for (let i = 0; i < fbxSkinneds.length; i++) {
    const fbx = fbxSkinneds[i];
    fbx.castShadow = true;
    fbx.receiveShadow = true;
    fbx.frustumCulled = false;

    const fbxVerts = fbx.geometry.attributes.position.count;
    const gl = gltfMeshes[i];
    const glVerts = gl ? gl.geometry.attributes.position.count : 0;

    if (gl && fbxVerts === glVerts) {
      const newGeom = gl.geometry.clone();
      const skinIdx = fbx.geometry.attributes.skinIndex;
      const skinWt = fbx.geometry.attributes.skinWeight;
      if (skinIdx) newGeom.setAttribute("skinIndex", skinIdx);
      if (skinWt) newGeom.setAttribute("skinWeight", skinWt);
      fbx.geometry.dispose();
      fbx.geometry = newGeom;
      fbx.material = gl.material;
      console.log(`[assets] mesh ${i}: geometry swap ok (${fbxVerts} verts)`);
    } else {
      if (Array.isArray(fbx.material)) {
        fbx.material = fbx.material.map(upgradeMat);
      } else {
        fbx.material = upgradeMat(fbx.material);
      }
      console.log(
        `[assets] mesh ${i}: using FBX native materials (fbx=${fbxVerts} verts, glb=${glVerts})`
      );
    }
  }

  baseRig = idleFbx;
  console.log(
    "[assets] character loaded, clips:",
    idleClip?.name,
    runClip?.name,
    deathClip?.name
  );

  const boneNames: string[] = [];
  idleFbx.traverse((obj) => {
    if (obj.type === "Bone") boneNames.push(obj.name);
  });
  console.log("[assets] bones:", boneNames.slice(0, 20), "...");

  const w = window as unknown as {
    __tweakScythe?: (
      px?: number,
      py?: number,
      pz?: number,
      rx?: number,
      ry?: number,
      rz?: number,
      scale?: number
    ) => void;
    __scythes?: THREE.Object3D[];
  };
  w.__tweakScythe = (
    px = 0,
    py = 0,
    pz = 0,
    rx = 0,
    ry = 0,
    rz = 0,
    scale = SCYTHE_SCALE
  ) => {
    for (const s of w.__scythes ?? []) {
      s.position.set(px, py, pz);
      s.rotation.set(rx, ry, rz);
      s.scale.setScalar(scale);
    }
    console.log(
      `[scythe] pos=(${px},${py},${pz}) rot=(${rx.toFixed(2)},${ry.toFixed(2)},${rz.toFixed(2)}) scale=${scale}`
    );
  };
  console.log(
    "[scythe] tweak via console: __tweakScythe(px, py, pz, rx, ry, rz, scale)"
  );
}

function makePlayerMesh(color: number, isSelf: boolean) {
  const group = new THREE.Group();

  let body: THREE.Mesh;
  let bodyMat: THREE.MeshStandardMaterial;
  let mixer: THREE.AnimationMixer | null = null;
  let idleAction: THREE.AnimationAction | null = null;
  let runAction: THREE.AnimationAction | null = null;
  let deathAction: THREE.AnimationAction | null = null;
  let attackAction: THREE.AnimationAction | null = null;
  let whirlwindAction: THREE.AnimationAction | null = null;
  let avatar: THREE.Object3D | null = null;
  let bladeTip: THREE.Object3D | null = null;
  let spineBone: THREE.Object3D | null = null;

  if (baseRig && idleClip) {
    avatar = SkeletonUtils.clone(baseRig);
    avatar.scale.setScalar(CHARACTER_SCALE);
    group.add(avatar);

    spineBone = findBoneBySuffix(avatar, "Spine");

    if (scytheTemplate) {
      const hand = findBoneBySuffix(avatar, "RightHand");
      if (hand) {
        const scythe = scytheTemplate.clone(true);
        scythe.scale.setScalar(SCYTHE_SCALE);
        scythe.position.copy(SCYTHE_POS);
        scythe.rotation.copy(SCYTHE_ROT);
        hand.add(scythe);
        bladeTip = new THREE.Object3D();
        bladeTip.position.copy(BLADE_TIP_OFFSET);
        scythe.add(bladeTip);
        const w = window as unknown as { __scythes?: THREE.Object3D[] };
        if (!w.__scythes) w.__scythes = [];
        w.__scythes.push(scythe);
      } else {
        console.warn("[character] RightHand bone not found");
      }
    }

    let firstSkinned: THREE.SkinnedMesh | null = null;
    avatar.traverse((obj) => {
      const m = obj as THREE.SkinnedMesh;
      if (m.isSkinnedMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false;
        if (!firstSkinned) firstSkinned = m;
      }
    });

    body = firstSkinned ?? new THREE.Mesh();
    const rawMat = (body as THREE.Mesh).material;
    if (rawMat && !Array.isArray(rawMat) && (rawMat as THREE.MeshStandardMaterial).isMaterial) {
      bodyMat = rawMat as THREE.MeshStandardMaterial;
    } else {
      bodyMat = new THREE.MeshStandardMaterial({ color });
    }

    mixer = new THREE.AnimationMixer(avatar);
    idleAction = mixer.clipAction(idleClip);
    idleAction.play();
    if (runClip) {
      runAction = mixer.clipAction(runClip);
      runAction.timeScale = 1.3;
      runAction.play();
      runAction.setEffectiveWeight(0);
    }
    idleAction.setEffectiveWeight(1);
    if (deathClip) {
      deathAction = mixer.clipAction(deathClip);
      deathAction.setLoop(THREE.LoopOnce, 1);
      deathAction.clampWhenFinished = true;
      deathAction.setEffectiveWeight(0);
    }
    if (attackClip) {
      attackAction = mixer.clipAction(attackClip);
      attackAction.setLoop(THREE.LoopOnce, 1);
      attackAction.clampWhenFinished = false;
      attackAction.timeScale = 1.4;
    }
    if (whirlwindClip) {
      whirlwindAction = mixer.clipAction(whirlwindClip);
      whirlwindAction.setLoop(THREE.LoopRepeat, Infinity);
      whirlwindAction.timeScale = 1.2;
      whirlwindAction.setEffectiveWeight(0);
    }
  } else {
    bodyMat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.5,
      metalness: 0.1,
    });
    body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.4, 0.9, 6, 12),
      bodyMat
    );
    body.position.y = 0.9;
    body.castShadow = true;
    group.add(body);

    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.15, 0.3, 8),
      new THREE.MeshStandardMaterial({ color: 0xfff2d0 })
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 1.0, 0.45);
    group.add(nose);
  }

  const hpBarGroup = new THREE.Group();
  hpBarGroup.position.y = 2.2;

  const bgGeom = new THREE.PlaneGeometry(1.0, 0.12);
  const bg = new THREE.Mesh(
    bgGeom,
    new THREE.MeshBasicMaterial({ color: 0x220000, transparent: true, opacity: 0.9 })
  );
  hpBarGroup.add(bg);

  const fgGeom = new THREE.PlaneGeometry(1.0, 0.1);
  fgGeom.translate(0.5, 0, 0);
  const fg = new THREE.Mesh(
    fgGeom,
    new THREE.MeshBasicMaterial({ color: 0x44dd44, depthTest: false })
  );
  fg.position.x = -0.5;
  fg.position.z = 0.002;
  fg.renderOrder = 10;
  hpBarGroup.add(fg);

  group.add(hpBarGroup);

  let coneOutline: THREE.LineLoop | null = null;
  if (isSelf) {
    coneOutline = new THREE.LineLoop(coneOutlineGeom, coneOutlineMat);
    coneOutline.position.y = 0.05;
    coneOutline.renderOrder = 2;
    group.add(coneOutline);
  }

  const stunAura = new THREE.Mesh(
    new THREE.TorusGeometry(0.55, 0.08, 8, 20),
    new THREE.MeshBasicMaterial({
      color: 0xcc88ff,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    })
  );
  stunAura.rotation.x = Math.PI / 2;
  stunAura.position.y = 2.3;
  stunAura.visible = false;
  stunAura.renderOrder = 12;
  group.add(stunAura);

  return {
    group,
    body,
    bodyMat,
    hpBarFg: fg,
    hpBarGroup,
    coneOutline,
    stunAura,
    mixer,
    idleAction,
    runAction,
    deathAction,
    attackAction,
    whirlwindAction,
    avatar,
    bladeTip,
    spineBone,
  };
}

function colorForId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  const hue = ((hash >>> 0) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.65, 0.55).getHex();
}

function updatePlayerVisuals(view: PlayerView, now: number) {
  const ratio = view.maxHp > 0 ? view.hp / view.maxHp : 0;
  view.hpBarFg.scale.x = Math.max(0, ratio);
  const hpColor = ratio > 0.6 ? 0x44dd44 : ratio > 0.3 ? 0xddcc44 : 0xdd4444;
  (view.hpBarFg.material as THREE.MeshBasicMaterial).color.setHex(hpColor);

  view.hpBarGroup.quaternion.copy(camera.quaternion);

  const stunned = Date.now() < view.stunnedUntil;
  if (stunned) {
    view.stunAura.visible = true;
    view.stunAura.rotation.z = (now * 0.006) % (Math.PI * 2);
    const pulse = 1 + Math.sin(now * 0.012) * 0.15;
    view.stunAura.scale.setScalar(pulse);
  } else {
    view.stunAura.visible = false;
  }

  view.group.scale.setScalar(1);
  const channeling = now < view.aoeSpinUntil;
  if (!view.alive) {
    view.hpBarGroup.visible = false;
    if (view.coneOutline) view.coneOutline.visible = false;
    view.stunAura.visible = false;
  } else {
    view.hpBarGroup.visible = true;
    if (view.coneOutline) view.coneOutline.visible = !channeling;
  }
}

const players = new Map<string, PlayerView>();

interface Effect {
  update: (now: number) => boolean;
  cleanup: () => void;
}
const effects: Effect[] = [];
function addEffect(e: Effect) {
  effects.push(e);
}

let shakeUntil = 0;
let shakeAmp = 0;
let shakeDuration = 1;
function shakeCamera(amp: number, durationMs: number) {
  const end = performance.now() + durationMs;
  if (end > shakeUntil) shakeUntil = end;
  if (amp > shakeAmp) {
    shakeAmp = amp;
    shakeDuration = durationMs;
  }
}

const AudioCtor: typeof AudioContext | undefined =
  typeof AudioContext !== "undefined" ? AudioContext : undefined;
const audioCtx: AudioContext | null = AudioCtor ? new AudioCtor() : null;
function resumeAudio() {
  if (audioCtx && audioCtx.state === "suspended") void audioCtx.resume();
}
function playClickSound() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(720, t);
  osc.frequency.exponentialRampToValueAtTime(380, t + 0.05);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.08, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.08);
}
function playHitSound(intensity = 1) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(170 * intensity, t);
  osc.frequency.exponentialRampToValueAtTime(55, t + 0.12);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.22 * intensity, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.17);

  const bufSize = Math.floor(audioCtx.sampleRate * 0.08);
  const buf = audioCtx.createBuffer(1, bufSize, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++)
    data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
  const noise = audioCtx.createBufferSource();
  noise.buffer = buf;
  const ng = audioCtx.createGain();
  ng.gain.value = 0.1 * intensity;
  noise.connect(ng).connect(audioCtx.destination);
  noise.start(t);
}

function spawnDamageNumber(
  worldPos: THREE.Vector3,
  damage: number,
  color: string = "#ffdd55"
) {
  const cvs = document.createElement("canvas");
  cvs.width = 128;
  cvs.height = 64;
  const ctx = cvs.getContext("2d");
  if (!ctx) return;
  ctx.font = "bold 44px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,0.9)";
  ctx.fillStyle = color;
  ctx.strokeText(String(damage), 64, 32);
  ctx.fillText(String(damage), 64, 32);

  const tex = new THREE.CanvasTexture(cvs);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.3, 0.65, 1);
  sprite.position
    .copy(worldPos)
    .add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 2.4, 0));
  sprite.renderOrder = 20;
  scene.add(sprite);

  const start = performance.now();
  const dur = 900;
  const startY = sprite.position.y;
  addEffect({
    update: (now) => {
      const p = (now - start) / dur;
      if (p >= 1) return false;
      sprite.position.y = startY + p * 1.2;
      mat.opacity = p < 0.15 ? p / 0.15 : 1 - (p - 0.15) / 0.85;
      return true;
    },
    cleanup: () => {
      scene.remove(sprite);
      tex.dispose();
      mat.dispose();
    },
  });
}

function spawnSlashVFX(worldPos: THREE.Vector3) {
  const geom = new THREE.PlaneGeometry(2.2, 0.8);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xfff0a0,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.copy(worldPos);
  mesh.position.y += 1.1;
  mesh.renderOrder = 15;
  const angle = (Math.random() - 0.5) * Math.PI;
  scene.add(mesh);

  const start = performance.now();
  const dur = 200;
  addEffect({
    update: (now) => {
      const p = (now - start) / dur;
      if (p >= 1) return false;
      const s = 0.5 + p * 1.3;
      mesh.scale.set(s, s, 1);
      mat.opacity = 0.95 * (1 - p);
      mesh.quaternion.copy(camera.quaternion);
      mesh.rotateZ(angle);
      return true;
    },
    cleanup: () => {
      scene.remove(mesh);
      geom.dispose();
      mat.dispose();
    },
  });
}

function makeVortexLayer(
  radius: number,
  opacity: number,
  fps: number,
  rotSpeed: number,
  frameOffset: number
) {
  if (!vortexTexture) return null;
  const tex = vortexTexture.clone();
  tex.needsUpdate = true;
  tex.repeat.set(1 / VORTEX_COLS, 1 / VORTEX_ROWS);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), mat);
  mesh.rotation.x = -Math.PI / 2;
  return {
    mesh,
    tex,
    mat,
    baseOpacity: opacity,
    fps,
    rotSpeed,
    frameOffset,
    update: (dt: number, fade: number) => {
      const totalFrames = VORTEX_COLS * VORTEX_ROWS;
      const f =
        (Math.floor(dt * fps) + frameOffset) % totalFrames;
      const col = f % VORTEX_COLS;
      const row = Math.floor(f / VORTEX_COLS);
      tex.offset.set(col / VORTEX_COLS, 1 - (row + 1) / VORTEX_ROWS);
      mesh.rotation.z = dt * rotSpeed;
      mat.opacity = opacity * fade;
    },
  };
}

function spawnSpinAura(ownerView: PlayerView, durationMs: number) {
  const AOE_R = 3.0;

  const layers: NonNullable<ReturnType<typeof makeVortexLayer>>[] = [];
  const l1 = makeVortexLayer(AOE_R, 0.95, 16, 1.2, 0);
  const l2 = makeVortexLayer(AOE_R * 0.7, 0.75, 20, -1.5, 6);
  const l3 = makeVortexLayer(AOE_R * 1.05, 0.55, 12, 0.7, 12);
  if (l1) layers.push(l1);
  if (l2) layers.push(l2);
  if (l3) layers.push(l3);

  const heights = [0.85, 1.0, 0.7];
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    l.mesh.position.y = heights[i] ?? 0.9;
    l.mesh.renderOrder = 5 + i;
    ownerView.group.add(l.mesh);
  }

  const start = performance.now();
  addEffect({
    update: (now) => {
      const dt = (now - start) / 1000;
      const t = (now - start) / durationMs;
      if (t >= 1) return false;
      const fade = t < 0.08 ? t / 0.08 : t > 0.88 ? (1 - t) / 0.12 : 1;
      for (const l of layers) l.update(dt, fade);
      return true;
    },
    cleanup: () => {
      for (const l of layers) {
        ownerView.group.remove(l.mesh);
        l.mesh.geometry.dispose();
        l.mat.dispose();
        l.tex.dispose();
      }
    },
  });
}

function spawnTrailPuff(worldPos: THREE.Vector3) {
  const mat = new THREE.SpriteMaterial({
    map: trailTexture,
    color: 0x66e0ff,
    transparent: true,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.55, 0.55, 1);
  sprite.position.copy(worldPos);
  sprite.renderOrder = 14;
  scene.add(sprite);
  const start = performance.now();
  const dur = 280;
  addEffect({
    update: (now) => {
      const t = (now - start) / dur;
      if (t >= 1) return false;
      mat.opacity = (1 - t) * 0.9;
      const s = 0.55 * (1 - t * 0.4);
      sprite.scale.set(s, s, 1);
      return true;
    },
    cleanup: () => {
      scene.remove(sprite);
      mat.dispose();
    },
  });
}

function spawnRiftPortal(worldPos: THREE.Vector3, reverse = false) {
  if (!riftTexture) return;
  const tex = riftTexture.clone();
  tex.needsUpdate = true;
  tex.repeat.set(1 / RIFT_COLS, 1 / RIFT_ROWS);
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(mat);
  const SCALE_W = 2.5;
  const SCALE_H = 4.0;
  sprite.scale.set(SCALE_W, SCALE_H, 1);
  sprite.position.copy(worldPos);
  sprite.position.y = SCALE_H / 2;
  sprite.renderOrder = 14;
  scene.add(sprite);

  const start = performance.now();
  const dur = reverse ? 280 : 380;
  addEffect({
    update: (now) => {
      const t = (now - start) / dur;
      if (t >= 1) return false;
      const p = reverse ? 1 - t : t;
      const frame = Math.min(RIFT_FRAMES - 1, Math.floor(p * RIFT_FRAMES));
      const col = frame % RIFT_COLS;
      const row = Math.floor(frame / RIFT_COLS);
      tex.offset.set(col / RIFT_COLS, 1 - (row + 1) / RIFT_ROWS);
      return true;
    },
    cleanup: () => {
      scene.remove(sprite);
      tex.dispose();
      mat.dispose();
    },
  });
}

function spawnPullChain(fromPos: THREE.Vector3, toPos: THREE.Vector3) {
  if (!chainTexture) return;
  const dx = toPos.x - fromPos.x;
  const dz = toPos.z - fromPos.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.1) return;
  const nx = dx / len;
  const nz = dz / len;
  const halfW = Math.max(0.6, len * 0.12);
  const pX = -nz * halfW;
  const pZ = nx * halfW;
  const y = 0.22;
  const verts = new Float32Array([
    fromPos.x - pX,
    y,
    fromPos.z - pZ,
    fromPos.x + pX,
    y,
    fromPos.z + pZ,
    toPos.x + pX,
    y,
    toPos.z + pZ,
    toPos.x - pX,
    y,
    toPos.z - pZ,
  ]);
  const uvs = new Float32Array([0, 1, 0, 0, 1, 0, 1, 1]);
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(new THREE.BufferAttribute(idx, 1));

  const tex = chainTexture.clone();
  tex.needsUpdate = true;
  tex.repeat.set(1 / CHAIN_COLS, 1 / CHAIN_ROWS);

  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.renderOrder = 14;
  scene.add(mesh);

  const start = performance.now();
  const dur = 420;
  addEffect({
    update: (now) => {
      const t = (now - start) / dur;
      if (t >= 1) return false;
      const frame = Math.min(CHAIN_FRAMES - 1, Math.floor(t * CHAIN_FRAMES));
      const col = frame % CHAIN_COLS;
      const row = Math.floor(frame / CHAIN_COLS);
      tex.offset.set(col / CHAIN_COLS, 1 - (row + 1) / CHAIN_ROWS);
      return true;
    },
    cleanup: () => {
      scene.remove(mesh);
      geom.dispose();
      mat.dispose();
      tex.dispose();
    },
  });
}

function spawnImpactShockwave(worldPos: THREE.Vector3, radius: number) {
  if (!impactTexture) return;
  const tex = impactTexture.clone();
  tex.needsUpdate = true;
  tex.repeat.set(1 / IMPACT_COLS, 1 / IMPACT_ROWS);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const size = radius * 2.5;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.copy(worldPos);
  mesh.position.y = 0.1;
  mesh.renderOrder = 13;
  scene.add(mesh);

  const start = performance.now();
  const dur = 520;
  addEffect({
    update: (now) => {
      const t = (now - start) / dur;
      if (t >= 1) return false;
      const frame = Math.min(
        IMPACT_FRAMES - 1,
        Math.floor(t * IMPACT_FRAMES)
      );
      const col = frame % IMPACT_COLS;
      const row = Math.floor(frame / IMPACT_COLS);
      tex.offset.set(col / IMPACT_COLS, 1 - (row + 1) / IMPACT_ROWS);
      return true;
    },
    cleanup: () => {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mat.dispose();
      tex.dispose();
    },
  });
}

function spawnStunBurst(worldPos: THREE.Vector3, radius: number) {
  const ringGeom = new THREE.RingGeometry(0.95, 1.05, 64);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xcc88ff,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(worldPos);
  ring.position.y = 0.08;
  ring.renderOrder = 6;
  scene.add(ring);

  const colGeom = new THREE.CylinderGeometry(
    radius * 0.9,
    radius * 0.2,
    3.2,
    32,
    1,
    true
  );
  const colMat = new THREE.MeshBasicMaterial({
    color: 0x9944dd,
    transparent: true,
    opacity: 0.5,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const col = new THREE.Mesh(colGeom, colMat);
  col.position.copy(worldPos);
  col.position.y = 1.6;
  col.renderOrder = 7;
  scene.add(col);

  const start = performance.now();
  const dur = 500;
  addEffect({
    update: (now) => {
      const p = (now - start) / dur;
      if (p >= 1) return false;
      const rs = Math.min(1, p * 2.2) * radius;
      ring.scale.set(rs, rs, 1);
      ringMat.opacity = 0.95 * (1 - p * p);
      colMat.opacity = 0.5 * (1 - p);
      col.scale.y = 1 + p * 0.4;
      return true;
    },
    cleanup: () => {
      scene.remove(ring);
      scene.remove(col);
      ringGeom.dispose();
      ringMat.dispose();
      colGeom.dispose();
      colMat.dispose();
    },
  });
}


function spawnSlashArc(ownerView: PlayerView) {
  if (!slashTexture) return;
  const tex = slashTexture.clone();
  tex.needsUpdate = true;
  tex.repeat.set(1 / SLASH_COLS, 1 / SLASH_ROWS);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const SIZE = 3.8;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), mat);
  plane.rotation.x = -Math.PI / 2;

  const container = new THREE.Object3D();
  container.add(plane);
  const rotY = ownerView.group.rotation.y;
  container.rotation.y = rotY;
  const FWD = 1.9;
  container.position.set(
    ownerView.group.position.x + Math.sin(rotY) * FWD,
    0.17,
    ownerView.group.position.z + Math.cos(rotY) * FWD
  );
  container.renderOrder = 13;
  scene.add(container);

  const start = performance.now();
  const dur = 260;
  addEffect({
    update: (now) => {
      const t = (now - start) / dur;
      if (t >= 1) return false;
      const frame = Math.min(SLASH_FRAMES - 1, Math.floor(t * SLASH_FRAMES));
      const col = frame % SLASH_COLS;
      const row = Math.floor(frame / SLASH_COLS);
      tex.offset.set(col / SLASH_COLS, 1 - (row + 1) / SLASH_ROWS);
      return true;
    },
    cleanup: () => {
      scene.remove(container);
      plane.geometry.dispose();
      mat.dispose();
      tex.dispose();
    },
  });
}

function spawnAutoConeFlash(ownerView: PlayerView) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffeeaa,
    transparent: true,
    opacity: 0.75,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(coneGeom, mat);
  mesh.position.y = 0.07;
  mesh.renderOrder = 8;
  ownerView.group.add(mesh);

  const start = performance.now();
  const dur = 220;
  addEffect({
    update: (now) => {
      const p = (now - start) / dur;
      if (p >= 1) return false;
      mat.opacity = 0.75 * (1 - p);
      return true;
    },
    cleanup: () => {
      ownerView.group.remove(mesh);
      mat.dispose();
    },
  });
}

function spawnAoESweep(worldPos: THREE.Vector3, radius: number) {
  const ringGeom = new THREE.RingGeometry(0.95, 1.0, 64);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0x66e0ff,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(worldPos);
  ring.position.y = 0.06;
  ring.renderOrder = 6;
  scene.add(ring);

  const diskGeom = new THREE.CircleGeometry(1, 64);
  const diskMat = new THREE.MeshBasicMaterial({
    color: 0xaaf0ff,
    transparent: true,
    opacity: 0.45,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const disk = new THREE.Mesh(diskGeom, diskMat);
  disk.rotation.x = -Math.PI / 2;
  disk.position.copy(worldPos);
  disk.position.y = 0.05;
  disk.renderOrder = 4;
  scene.add(disk);

  const swirlGeom = new THREE.RingGeometry(0.4, 0.7, 48, 1, 0, Math.PI * 1.2);
  const swirlMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const swirl = new THREE.Mesh(swirlGeom, swirlMat);
  swirl.rotation.x = -Math.PI / 2;
  swirl.position.copy(worldPos);
  swirl.position.y = 0.9;
  swirl.renderOrder = 7;
  scene.add(swirl);

  const start = performance.now();
  const dur = 360;
  addEffect({
    update: (now) => {
      const p = (now - start) / dur;
      if (p >= 1) return false;
      const ringS = Math.min(1, p / 0.55) * radius;
      ring.scale.set(ringS, ringS, 1);
      ringMat.opacity = 0.95 * (1 - p * p);
      const diskS = Math.min(1, p / 0.25) * radius * 0.85;
      disk.scale.set(diskS, diskS, 1);
      diskMat.opacity = 0.45 * Math.max(0, 1 - p * 1.6);
      const swirlS = Math.min(1, p / 0.4) * radius * 1.1;
      swirl.scale.set(swirlS, swirlS, 1);
      swirl.rotation.z = p * Math.PI * 2;
      swirlMat.opacity = 0.85 * (1 - p);
      return true;
    },
    cleanup: () => {
      scene.remove(ring);
      scene.remove(disk);
      scene.remove(swirl);
      ringGeom.dispose();
      ringMat.dispose();
      diskGeom.dispose();
      diskMat.dispose();
      swirlGeom.dispose();
      swirlMat.dispose();
    },
  });
}

const keys = new Set<string>();
window.addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

const joystickEl = document.getElementById("joystick") as HTMLDivElement;
const joystickThumb = document.getElementById("joystick-thumb") as HTMLDivElement;
const JOY_RADIUS_PX = 50;
const joyVec = { x: 0, z: 0 };
let joyActive = false;
let joyPointerId: number | null = null;

function updateJoy(e: PointerEvent) {
  const rect = joystickEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let dx = e.clientX - cx;
  let dy = e.clientY - cy;
  const dist = Math.hypot(dx, dy);
  if (dist > JOY_RADIUS_PX) {
    dx = (dx / dist) * JOY_RADIUS_PX;
    dy = (dy / dist) * JOY_RADIUS_PX;
  }
  joystickThumb.style.transform = `translate(${dx}px, ${dy}px)`;
  joyVec.x = dx / JOY_RADIUS_PX;
  joyVec.z = dy / JOY_RADIUS_PX;
}
function resetJoy() {
  joyActive = false;
  joyPointerId = null;
  joyVec.x = 0;
  joyVec.z = 0;
  joystickThumb.style.transform = "translate(0, 0)";
}

joystickEl.addEventListener("pointerdown", (e) => {
  if (joyActive) return;
  joyActive = true;
  joyPointerId = e.pointerId;
  joystickEl.setPointerCapture(e.pointerId);
  updateJoy(e);
});
joystickEl.addEventListener("pointermove", (e) => {
  if (!joyActive || e.pointerId !== joyPointerId) return;
  updateJoy(e);
});
joystickEl.addEventListener("pointerup", (e) => {
  if (e.pointerId !== joyPointerId) return;
  resetJoy();
});
joystickEl.addEventListener("pointercancel", (e) => {
  if (e.pointerId !== joyPointerId) return;
  resetJoy();
});

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

const CLIENT_AOE_RANGE = 3.0;
const CLIENT_AOE_COOLDOWN_MS = 0;
const CLIENT_AOE_CHANNEL_MS = 3000;
const CLIENT_LEAP_RANGE = 10.0;
const CLIENT_LEAP_RADIUS = 3.0;
const CLIENT_LEAP_COOLDOWN_MS = 0;
const CLIENT_PULL_COOLDOWN_MS = 0;
const CLIENT_RIFT_HIDE_MS = 280;
let lastLocalAoeAt = -CLIENT_AOE_COOLDOWN_MS;
let lastLocalLeapAt = -CLIENT_LEAP_COOLDOWN_MS;
let lastLocalPullAt = -CLIENT_PULL_COOLDOWN_MS;

let targetingMode: null | "leap" | "pull" = null;
let leapReticle: THREE.Mesh | null = null;
let leapRangeRing: THREE.Mesh | null = null;
let pullCone: THREE.Mesh | null = null;
let pullAimDir = new THREE.Vector3(0, 0, 1);
const PULL_RANGE_CLIENT = 12.0;
const PULL_HALF_WIDTH_CLIENT = 0.8;

function createLeapReticle(): THREE.Mesh {
  const geom = new THREE.RingGeometry(
    CLIENT_LEAP_RADIUS * 0.93,
    CLIENT_LEAP_RADIUS,
    48
  );
  const mat = new THREE.MeshBasicMaterial({
    color: 0x88ccff,
    transparent: true,
    opacity: 0.85,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.07;
  mesh.renderOrder = 9;
  scene.add(mesh);
  return mesh;
}

function createLeapRangeRing(): THREE.Mesh {
  const geom = new THREE.RingGeometry(
    CLIENT_LEAP_RANGE - 0.08,
    CLIENT_LEAP_RANGE,
    64
  );
  const mat = new THREE.MeshBasicMaterial({
    color: 0x66b0ff,
    transparent: true,
    opacity: 0.45,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.05;
  mesh.renderOrder = 8;
  scene.add(mesh);
  return mesh;
}

const pullLineGeom = (() => {
  const w = PULL_HALF_WIDTH_CLIENT;
  const r = PULL_RANGE_CLIENT;
  const verts = new Float32Array([-w, 0, 0, w, 0, 0, w, 0, r, -w, 0, r]);
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geom.setIndex(new THREE.BufferAttribute(idx, 1));
  geom.computeVertexNormals();
  return geom;
})();
function createPullCone(): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xcc88ff,
    transparent: true,
    opacity: 0.45,
    depthTest: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const mesh = new THREE.Mesh(pullLineGeom, mat);
  mesh.position.y = 0.06;
  mesh.renderOrder = 9;
  scene.add(mesh);
  return mesh;
}

const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
function raycastToGround(
  clientX: number,
  clientY: number,
  out: THREE.Vector3
): boolean {
  _ndc.x = (clientX / window.innerWidth) * 2 - 1;
  _ndc.y = -(clientY / window.innerHeight) * 2 + 1;
  _raycaster.setFromCamera(_ndc, camera);
  return _raycaster.ray.intersectPlane(_groundPlane, out) !== null;
}

function clampToLeapRange(
  pos: THREE.Vector3,
  origin: THREE.Vector3
): THREE.Vector3 {
  const dx = pos.x - origin.x;
  const dz = pos.z - origin.z;
  const dist = Math.hypot(dx, dz);
  if (dist > CLIENT_LEAP_RANGE) {
    const f = CLIENT_LEAP_RANGE / dist;
    pos.x = origin.x + dx * f;
    pos.z = origin.z + dz * f;
  }
  return pos;
}

function amSelfStunned(): boolean {
  if (!mySessionId) return false;
  const me = players.get(mySessionId);
  if (!me) return false;
  return Date.now() < me.stunnedUntil;
}

function amSelfChanneling(): boolean {
  if (!mySessionId) return false;
  const me = players.get(mySessionId);
  if (!me) return false;
  return performance.now() < me.aoeSpinUntil;
}

function enterLeapTargeting() {
  if (!room || !mySessionId) return;
  const me = players.get(mySessionId);
  if (!me || !me.alive || amSelfStunned() || amSelfChanneling()) return;
  if (performance.now() - lastLocalLeapAt < CLIENT_LEAP_COOLDOWN_MS) return;
  if (!leapReticle) leapReticle = createLeapReticle();
  if (!leapRangeRing) leapRangeRing = createLeapRangeRing();
  leapReticle.position.x = me.group.position.x;
  leapReticle.position.z = me.group.position.z + 4;
  leapReticle.visible = true;
  leapRangeRing.position.x = me.group.position.x;
  leapRangeRing.position.z = me.group.position.z;
  leapRangeRing.visible = true;
  targetingMode = "leap";
}
function exitLeapTargeting() {
  if (targetingMode === "leap") targetingMode = null;
  if (leapReticle) leapReticle.visible = false;
  if (leapRangeRing) leapRangeRing.visible = false;
}

function enterPullTargeting() {
  if (!room || !mySessionId) return;
  const me = players.get(mySessionId);
  if (!me || !me.alive || amSelfStunned() || amSelfChanneling()) return;
  if (performance.now() - lastLocalPullAt < CLIENT_PULL_COOLDOWN_MS) return;
  if (!pullCone) pullCone = createPullCone();
  const forwardZ = Math.cos(me.group.rotation.y);
  const forwardX = Math.sin(me.group.rotation.y);
  pullAimDir.set(forwardX, 0, forwardZ);
  pullCone.position.x = me.group.position.x;
  pullCone.position.z = me.group.position.z;
  pullCone.rotation.y = me.group.rotation.y;
  pullCone.visible = true;
  targetingMode = "pull";
}
function exitPullTargeting() {
  if (targetingMode === "pull") targetingMode = null;
  if (pullCone) pullCone.visible = false;
}
function exitAnyTargeting() {
  exitLeapTargeting();
  exitPullTargeting();
}

function castLeap(x: number, z: number) {
  if (!room || !mySessionId) return;
  const me = players.get(mySessionId);
  if (!me || !me.alive || amSelfStunned() || amSelfChanneling()) return;
  const now = performance.now();
  if (now - lastLocalLeapAt < CLIENT_LEAP_COOLDOWN_MS) return;
  lastLocalLeapAt = now;
  resumeAudio();
  room.send("ability", { id: "leap", x, z });
  localPos.set(x, 0, z);
  me.group.position.x = x;
  me.group.position.z = z;
  playClickSound();
}

function castPull(dirX?: number, dirZ?: number) {
  if (!room || !mySessionId) return;
  const me = players.get(mySessionId);
  if (!me || !me.alive || amSelfStunned() || amSelfChanneling()) return;
  const now = performance.now();
  if (now - lastLocalPullAt < CLIENT_PULL_COOLDOWN_MS) return;
  lastLocalPullAt = now;
  resumeAudio();
  if (typeof dirX === "number" && typeof dirZ === "number") {
    room.send("ability", { id: "pull", x: dirX, z: dirZ });
    localRotY = Math.atan2(dirX, dirZ);
  } else {
    room.send("ability", { id: "pull" });
  }
  playClickSound();
}

canvas.addEventListener("pointerdown", (e) => {
  if (!room || !mySessionId) return;
  const me = players.get(mySessionId);
  if (!me || !me.alive || amSelfStunned() || amSelfChanneling()) return;

  if (targetingMode === "leap") {
    const p = new THREE.Vector3();
    if (!raycastToGround(e.clientX, e.clientY, p)) return;
    clampToLeapRange(p, me.group.position);
    castLeap(p.x, p.z);
    exitLeapTargeting();
    return;
  }
  if (targetingMode === "pull") {
    castPull(pullAimDir.x, pullAimDir.z);
    exitPullTargeting();
    return;
  }
});

function castAoe() {
  if (!room || !mySessionId) return;
  const me = players.get(mySessionId);
  if (!me || !me.alive || amSelfStunned() || amSelfChanneling()) return;
  const now = performance.now();
  if (now - lastLocalAoeAt < CLIENT_AOE_COOLDOWN_MS) return;
  lastLocalAoeAt = now;
  resumeAudio();
  room.send("ability", { id: "aoe" });
  playClickSound();
  me.aoeSpinStart = now;
  me.aoeSpinUntil = now + CLIENT_AOE_CHANNEL_MS;
  spawnSpinAura(me, CLIENT_AOE_CHANNEL_MS);
}

let leapHoldPointerId: number | null = null;
let pullHoldPointerId: number | null = null;

window.addEventListener("pointermove", (e) => {
  if (!mySessionId) return;
  const me = players.get(mySessionId);
  if (!me) return;
  if (e.pointerType === "touch") {
    if (
      e.pointerId !== leapHoldPointerId &&
      e.pointerId !== pullHoldPointerId
    ) {
      return;
    }
  }
  if (targetingMode === "leap" && leapReticle) {
    const p = new THREE.Vector3();
    if (!raycastToGround(e.clientX, e.clientY, p)) return;
    clampToLeapRange(p, me.group.position);
    leapReticle.position.x = p.x;
    leapReticle.position.z = p.z;
  } else if (targetingMode === "pull" && pullCone) {
    const p = new THREE.Vector3();
    if (!raycastToGround(e.clientX, e.clientY, p)) return;
    const dx = p.x - me.group.position.x;
    const dz = p.z - me.group.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return;
    pullAimDir.set(dx / d, 0, dz / d);
    pullCone.position.x = me.group.position.x;
    pullCone.position.z = me.group.position.z;
    pullCone.rotation.y = Math.atan2(pullAimDir.x, pullAimDir.z);
  }
});

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "q") {
    if (targetingMode === "leap") exitLeapTargeting();
    else {
      exitAnyTargeting();
      enterLeapTargeting();
    }
  } else if (k === "e") {
    if (targetingMode === "pull") exitPullTargeting();
    else {
      exitAnyTargeting();
      enterPullTargeting();
    }
  } else if (k === "escape") {
    exitAnyTargeting();
  }
});

window.addEventListener("contextmenu", (e) => {
  if (targetingMode) {
    e.preventDefault();
    exitAnyTargeting();
  }
});

const btnLeap = document.getElementById("btn-leap") as HTMLDivElement;
const btnPull = document.getElementById("btn-pull") as HTMLDivElement;
const btnSpin = document.getElementById("btn-spin") as HTMLDivElement;
const cdLeapEl = document.getElementById("cd-leap") as HTMLDivElement;
const cdPullEl = document.getElementById("cd-pull") as HTMLDivElement;
const cdSpinEl = document.getElementById("cd-spin") as HTMLDivElement;
btnSpin.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  exitAnyTargeting();
  castAoe();
});
function updateAimFromPointer(e: PointerEvent) {
  if (!mySessionId) return;
  const me = players.get(mySessionId);
  if (!me) return;
  if (targetingMode === "leap" && leapReticle) {
    const p = new THREE.Vector3();
    if (!raycastToGround(e.clientX, e.clientY, p)) return;
    clampToLeapRange(p, me.group.position);
    leapReticle.position.x = p.x;
    leapReticle.position.z = p.z;
  } else if (targetingMode === "pull" && pullCone) {
    const p = new THREE.Vector3();
    if (!raycastToGround(e.clientX, e.clientY, p)) return;
    const dx = p.x - me.group.position.x;
    const dz = p.z - me.group.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return;
    pullAimDir.set(dx / d, 0, dz / d);
    pullCone.position.x = me.group.position.x;
    pullCone.position.z = me.group.position.z;
    pullCone.rotation.y = Math.atan2(pullAimDir.x, pullAimDir.z);
  }
}

btnLeap.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  exitAnyTargeting();
  enterLeapTargeting();
  if (targetingMode === "leap") {
    leapHoldPointerId = e.pointerId;
    try {
      btnLeap.setPointerCapture(e.pointerId);
    } catch {}
  }
});
btnLeap.addEventListener("pointermove", (e) => {
  if (leapHoldPointerId !== e.pointerId) return;
  updateAimFromPointer(e);
});
const endLeapHold = (e: PointerEvent) => {
  if (leapHoldPointerId !== e.pointerId) return;
  leapHoldPointerId = null;
  if (targetingMode === "leap" && leapReticle) {
    castLeap(leapReticle.position.x, leapReticle.position.z);
  }
  exitLeapTargeting();
};
btnLeap.addEventListener("pointerup", endLeapHold);
btnLeap.addEventListener("pointercancel", endLeapHold);

btnPull.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  exitAnyTargeting();
  enterPullTargeting();
  if (targetingMode === "pull") {
    pullHoldPointerId = e.pointerId;
    try {
      btnPull.setPointerCapture(e.pointerId);
    } catch {}
  }
});
btnPull.addEventListener("pointermove", (e) => {
  if (pullHoldPointerId !== e.pointerId) return;
  updateAimFromPointer(e);
});
const endPullHold = (e: PointerEvent) => {
  if (pullHoldPointerId !== e.pointerId) return;
  pullHoldPointerId = null;
  if (targetingMode === "pull") {
    castPull(pullAimDir.x, pullAimDir.z);
  }
  exitPullTargeting();
};
btnPull.addEventListener("pointerup", endPullHold);
btnPull.addEventListener("pointercancel", endPullHold);

function updateCooldownUI(now: number) {
  const leapRem = Math.max(
    0,
    CLIENT_LEAP_COOLDOWN_MS - (now - lastLocalLeapAt)
  );
  if (leapRem > 0) {
    cdLeapEl.classList.add("active");
    cdLeapEl.textContent =
      leapRem > 1000 ? Math.ceil(leapRem / 1000).toString() : "";
  } else {
    cdLeapEl.classList.remove("active");
  }
  const pullRem = Math.max(
    0,
    CLIENT_PULL_COOLDOWN_MS - (now - lastLocalPullAt)
  );
  if (pullRem > 0) {
    cdPullEl.classList.add("active");
    cdPullEl.textContent =
      pullRem > 1000 ? Math.ceil(pullRem / 1000).toString() : "";
  } else {
    cdPullEl.classList.remove("active");
  }
  const aoeRem = Math.max(
    0,
    CLIENT_AOE_COOLDOWN_MS - (now - lastLocalAoeAt)
  );
  if (aoeRem > 0) {
    cdSpinEl.classList.add("active");
    cdSpinEl.textContent =
      aoeRem > 1000 ? Math.ceil(aoeRem / 1000).toString() : "";
  } else {
    cdSpinEl.classList.remove("active");
  }
  btnLeap.classList.toggle("targeting", targetingMode === "leap");
  btnPull.classList.toggle("targeting", targetingMode === "pull");
}

const SERVER_URL =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env
    .VITE_SERVER_URL ?? "ws://localhost:2570";

const client = new Client(SERVER_URL);
let room: Room | null = null;
let mySessionId: string | null = null;

const localPos = new THREE.Vector3();
let localRotY = 0;

async function connect(): Promise<void> {
  try {
    statusEl.textContent = "connecting…";
    const playerName = nameInput.value.trim() || "Warrior";
    room = await client.joinOrCreate("game_room", { name: playerName });
    mySessionId = room.sessionId;
    statusEl.textContent = `connected · id ${mySessionId.slice(0, 4)}`;

    const $ = getStateCallbacks(room);

    $(room.state).players.onAdd((player: PlayerSchema, id: string) => {
      if (room && room.state.players.size >= 2) {
        stopSearchDots();
        hideSearching();
        showScoreHud();
      }
      updateScoreHud();
      const mesh = makePlayerMesh(colorForId(id), id === mySessionId);
      const view: PlayerView = {
        group: mesh.group,
        body: mesh.body,
        bodyMat: mesh.bodyMat,
        hpBarFg: mesh.hpBarFg,
        hpBarGroup: mesh.hpBarGroup,
        coneOutline: mesh.coneOutline,
        stunAura: mesh.stunAura,
        mixer: mesh.mixer,
        idleAction: mesh.idleAction,
        runAction: mesh.runAction,
        deathAction: mesh.deathAction,
        attackAction: mesh.attackAction,
        whirlwindAction: mesh.whirlwindAction,
        avatar: mesh.avatar,
        spineBone: mesh.spineBone,
        aoeSpinStart: 0,
        aoeSpinUntil: 0,
        bladeTip: mesh.bladeTip,
        target: new THREE.Vector3(player.x, 0, player.z),
        targetRotY: player.rotationY,
        hp: player.hp,
        maxHp: player.maxHp,
        alive: player.alive,
        flashUntil: 0,
        attackScaleUntil: 0,
        stunnedUntil: player.stunnedUntil,
        slowedUntil: player.slowedUntil,
        riftHideUntil: 0,
        attackingUntil: 0,
        lastPos: new THREE.Vector3(player.x, 0, player.z),
      };
      view.group.position.set(player.x, 0, player.z);
      view.group.rotation.y = player.rotationY;
      scene.add(view.group);
      players.set(id, view);

      if (id === mySessionId) {
        localPos.set(player.x, 0, player.z);
        localRotY = player.rotationY;
      }

      let prevAlive = player.alive;
      $(player).onChange(() => {
        view.target.set(player.x, 0, player.z);
        view.targetRotY = player.rotationY;
        view.hp = player.hp;
        view.maxHp = player.maxHp;
        view.alive = player.alive;
        view.stunnedUntil = player.stunnedUntil;
        view.slowedUntil = player.slowedUntil;
        updateScoreHud();
        if (id === mySessionId) {
          if (!player.alive) {
            localPos.set(player.x, 0, player.z);
          } else if (!prevAlive) {
            localPos.set(player.x, 0, player.z);
          }
        }
        if (view.deathAction) {
          if (prevAlive && !player.alive) {
            view.deathAction.reset();
            view.deathAction.setEffectiveWeight(1);
            view.deathAction.fadeIn(0.15);
            view.deathAction.play();
          } else if (!prevAlive && player.alive) {
            view.deathAction.fadeOut(0.15);
            view.deathAction.stop();
          }
        }
        prevAlive = player.alive;
      });
    });

    $(room.state).players.onRemove((_player: PlayerSchema, id: string) => {
      const v = players.get(id);
      if (v) {
        scene.remove(v.group);
        players.delete(id);
      }
    });

    room.onMessage(
      "leap_cast",
      (msg: {
        attackerId: string;
        sourceX: number;
        sourceZ: number;
        targetX: number;
        targetZ: number;
        radius: number;
        stunDuration: number;
        hits: { targetId: string; damage: number; stunnedUntil: number }[];
      }) => {
        const now = performance.now();
        spawnRiftPortal(new THREE.Vector3(msg.sourceX, 0, msg.sourceZ), true);
        spawnRiftPortal(new THREE.Vector3(msg.targetX, 0, msg.targetZ), false);
        spawnImpactShockwave(
          new THREE.Vector3(msg.targetX, 0, msg.targetZ),
          msg.radius
        );
        const atk = players.get(msg.attackerId);
        if (atk) atk.riftHideUntil = now + CLIENT_RIFT_HIDE_MS;
        for (const hit of msg.hits) {
          const tgt = players.get(hit.targetId);
          if (!tgt) continue;
          tgt.flashUntil = now + 180;
          spawnDamageNumber(tgt.group.position, hit.damage, "#9fccff");
        }
        if (msg.attackerId === mySessionId) {
          localPos.set(msg.targetX, 0, msg.targetZ);
          shakeCamera(0.14, 160);
          playHitSound(0.9);
        } else if (msg.hits.some((h) => h.targetId === mySessionId)) {
          shakeCamera(0.3, 240);
          playHitSound(1.1);
        } else if (msg.hits.length > 0) {
          playHitSound(0.45);
        }
      }
    );

    room.onMessage(
      "pull_cast",
      (msg: {
        attackerId: string;
        targetId: string;
        sourceX: number;
        sourceZ: number;
        landX: number;
        landZ: number;
        damage: number;
        slowDuration: number;
      }) => {
        const now = performance.now();
        const atk = players.get(msg.attackerId);
        const tgt = players.get(msg.targetId);
        const srcPos = new THREE.Vector3(msg.sourceX, 0, msg.sourceZ);
        const dstPos = atk
          ? new THREE.Vector3(atk.group.position.x, 0, atk.group.position.z)
          : new THREE.Vector3(msg.landX, 0, msg.landZ);
        spawnPullChain(srcPos, dstPos);
        spawnRiftPortal(srcPos, true);
        if (tgt) {
          tgt.flashUntil = now + 180;
          spawnDamageNumber(tgt.group.position, msg.damage, "#cc99ff");
        }
        if (msg.attackerId === mySessionId) {
          shakeCamera(0.1, 120);
          playHitSound(0.7);
        } else if (msg.targetId === mySessionId) {
          localPos.set(msg.landX, 0, msg.landZ);
          shakeCamera(0.2, 180);
          playHitSound(1.0);
        } else {
          playHitSound(0.4);
        }
      }
    );

    room.onMessage(
      "auto_hit",
      (msg: { attackerId: string; targetId: string; damage: number }) => {
        const now = performance.now();
        const atk = players.get(msg.attackerId);
        const tgt = players.get(msg.targetId);
        if (atk) {
          spawnSlashArc(atk);
          if (atk.alive && atk.attackAction) {
            atk.attackAction.stop();
            atk.attackAction.reset();
            atk.attackAction.setEffectiveWeight(5);
            atk.attackAction.play();
          }
        }
        if (!tgt) return;
        tgt.flashUntil = now + 150;
        spawnDamageNumber(tgt.group.position, msg.damage);
        if (msg.attackerId === mySessionId) {
          shakeCamera(0.06, 80);
          playHitSound(0.55);
        } else if (msg.targetId === mySessionId) {
          shakeCamera(0.18, 140);
          playHitSound(0.8);
        } else {
          playHitSound(0.3);
        }
      }
    );

    room.onMessage(
      "aoe_start",
      (msg: {
        attackerId: string;
        x: number;
        z: number;
        range: number;
        duration: number;
      }) => {
        const now = performance.now();
        const atk = players.get(msg.attackerId);
        if (!atk) return;
        if (msg.attackerId !== mySessionId) {
          spawnSpinAura(atk, msg.duration);
        }
        atk.aoeSpinStart = now;
        atk.aoeSpinUntil = now + msg.duration;
      }
    );

    room.onMessage(
      "aoe_tick",
      (msg: {
        attackerId: string;
        x: number;
        z: number;
        range: number;
        hits: { targetId: string; damage: number }[];
      }) => {
        const now = performance.now();
        for (const hit of msg.hits) {
          const tgt = players.get(hit.targetId);
          if (!tgt) continue;
          tgt.flashUntil = now + 180;
          spawnSlashVFX(tgt.group.position);
          spawnDamageNumber(tgt.group.position, hit.damage);
        }
        if (msg.hits.length > 0) {
          if (msg.attackerId === mySessionId) {
            shakeCamera(0.1, 100);
            playHitSound(0.9);
          } else if (msg.hits.some((h) => h.targetId === mySessionId)) {
            shakeCamera(0.22, 160);
            playHitSound(1.1);
          } else {
            playHitSound(0.4);
          }
        }
      }
    );

    room.onMessage("aoe_end", (msg: { attackerId: string }) => {
      const atk = players.get(msg.attackerId);
      if (!atk) return;
      atk.aoeSpinUntil = performance.now();
    });

    room.onMessage("death", (_msg: { victimId: string; killerId: string }) => {
      // death is reflected through player.alive state change
    });

    room.onMessage(
      "match_over",
      (msg: {
        winnerId: string;
        scores: Record<string, number>;
        winsRequired: number;
      }) => {
        matchOver = true;
        stopSearchDots();
        const myScore =
          mySessionId && msg.scores[mySessionId] !== undefined
            ? msg.scores[mySessionId]
            : 0;
        let oppScore = 0;
        for (const id in msg.scores) {
          if (id !== mySessionId) oppScore = msg.scores[id];
        }
        const victory = msg.winnerId === mySessionId;
        showEndScreen(victory, myScore, oppScore);
      }
    );

    room.onLeave(() => {
      if (matchOver) {
        statusEl.textContent = "match ended";
        return;
      }
      statusEl.textContent = "disconnected · retrying…";
      setTimeout(connect, 1500);
    });
  } catch (err) {
    console.error(err);
    statusEl.textContent = "failed · retrying…";
    setTimeout(connect, 1500);
  }
}

const menuOverlay = document.getElementById("menu-overlay") as HTMLDivElement;
const searchingOverlay = document.getElementById(
  "searching-overlay"
) as HTMLDivElement;
const searchingSubEl = document.getElementById(
  "searching-sub"
) as HTMLDivElement;
const searchingDotsEl = document.getElementById(
  "searching-dots"
) as HTMLDivElement;
const cancelBtn = document.getElementById("cancel-btn") as HTMLButtonElement;
const endOverlay = document.getElementById("end-overlay") as HTMLDivElement;
const playBtn = document.getElementById("play-btn") as HTMLButtonElement;
const againBtn = document.getElementById("again-btn") as HTMLButtonElement;
const nameInput = document.getElementById("name-input") as HTMLInputElement;
const scoreHud = document.getElementById("score-hud") as HTMLDivElement;
const scoreMeEl = document.getElementById("score-me") as HTMLSpanElement;
const scoreOppEl = document.getElementById("score-opp") as HTMLSpanElement;
const endTitleEl = document.getElementById("end-title") as HTMLHeadingElement;
const endScoreEl = document.getElementById("end-score") as HTMLDivElement;

let assetsLoaded = false;
let matchOver = false;
let shouldReconnect = false;

async function ensureAssets() {
  if (assetsLoaded) return;
  try {
    statusEl.textContent = "loading assets…";
    playBtn.disabled = true;
    playBtn.textContent = "LOADING…";
    await loadCharacterAssets();
    assetsLoaded = true;
  } catch (err) {
    console.error("[assets] load failed, falling back to capsules", err);
  } finally {
    playBtn.disabled = false;
    playBtn.textContent = "ENTER ARENA";
  }
}

function showMenu() {
  menuOverlay.classList.remove("hidden");
  searchingOverlay.classList.add("hidden");
  endOverlay.classList.add("hidden");
  scoreHud.classList.add("hidden");
  statusEl.textContent = "menu";
}
function hideMenu() {
  menuOverlay.classList.add("hidden");
}
function showSearching() {
  searchingOverlay.classList.remove("hidden");
  searchingSubEl.textContent = "Waiting for opponent…";
  statusEl.textContent = "searching";
}
function hideSearching() {
  searchingOverlay.classList.add("hidden");
}
function showScoreHud() {
  scoreHud.classList.remove("hidden");
}
function updateScoreHud() {
  if (!room || !mySessionId) return;
  let me = 0;
  let opp = 0;
  room.state.players.forEach(
    (p: { wins?: number }, id: string) => {
      const w = p.wins ?? 0;
      if (id === mySessionId) me = w;
      else opp = w;
    }
  );
  scoreMeEl.textContent = String(me);
  scoreOppEl.textContent = String(opp);
}
let searchDotsTimer: ReturnType<typeof setInterval> | null = null;
function startSearchDots() {
  let i = 0;
  if (searchDotsTimer) clearInterval(searchDotsTimer);
  searchDotsTimer = setInterval(() => {
    i = (i + 1) % 4;
    searchingDotsEl.textContent = "• ".repeat(i).trim() || " ";
  }, 420);
}
function stopSearchDots() {
  if (searchDotsTimer) {
    clearInterval(searchDotsTimer);
    searchDotsTimer = null;
  }
}
function showEndScreen(victory: boolean, myScore: number, oppScore: number) {
  endTitleEl.textContent = victory ? "VICTORY" : "DEFEAT";
  endTitleEl.className = victory ? "victory" : "defeat";
  endScoreEl.textContent = `${myScore} — ${oppScore}`;
  endOverlay.classList.remove("hidden");
  scoreHud.classList.add("hidden");
}

playBtn.addEventListener("click", async () => {
  goFullscreenLandscape();
  await ensureAssets();
  hideMenu();
  showSearching();
  startSearchDots();
  matchOver = false;
  shouldReconnect = false;
  connect();
});

againBtn.addEventListener("click", () => {
  goFullscreenLandscape();
  endOverlay.classList.add("hidden");
  showSearching();
  startSearchDots();
  matchOver = false;
  shouldReconnect = false;
  connect();
});

cancelBtn.addEventListener("click", () => {
  stopSearchDots();
  if (room) {
    try {
      room.leave();
    } catch {}
  }
  room = null;
  mySessionId = null;
  matchOver = true;
  showMenu();
});

ensureAssets();

const SPEED = 9;
const SEND_INTERVAL = 50;
let lastTime = performance.now();
let lastSend = 0;

function tick(): void {
  const now = performance.now();
  const dt = Math.min((now - lastTime) / 1000, 0.1);
  lastTime = now;

  const me = mySessionId ? players.get(mySessionId) : null;
  const stunned = me ? Date.now() < me.stunnedUntil : false;
  const channeling = me ? performance.now() < me.aoeSpinUntil : false;
  const rifting = me ? now < me.riftHideUntil : false;
  const canMove = (me?.alive ?? false) && !stunned && !rifting;
  if ((stunned || channeling || rifting) && targetingMode) exitAnyTargeting();

  let dx = 0;
  let dz = 0;
  if (canMove) {
    if (joyActive) {
      dx = joyVec.x;
      dz = joyVec.z;
    } else {
      if (keys.has("w") || keys.has("arrowup")) dz -= 1;
      if (keys.has("s") || keys.has("arrowdown")) dz += 1;
      if (keys.has("a") || keys.has("arrowleft")) dx -= 1;
      if (keys.has("d") || keys.has("arrowright")) dx += 1;
    }
  }

  const mag = Math.hypot(dx, dz);
  const moving = mag > 0.05;
  const slowed = me ? Date.now() < me.slowedUntil : false;
  if (moving) {
    const nx = dx / mag;
    const nz = dz / mag;
    const speedScale = Math.min(1, mag);
    const channelMul = channeling ? 0.5 : 1;
    const slowMul = slowed ? 0.5 : 1;
    localPos.x += nx * SPEED * speedScale * channelMul * slowMul * dt;
    localPos.z += nz * SPEED * speedScale * channelMul * slowMul * dt;
    localRotY = Math.atan2(nx, nz);
  }

  if (me && canMove) {
    me.group.position.x = localPos.x;
    me.group.position.z = localPos.z;
    me.group.rotation.y = localRotY;
  } else if (me) {
    me.group.position.x = me.target.x;
    me.group.position.z = me.target.z;
    localPos.copy(me.target);
  }

  if (room && moving && canMove && now - lastSend > SEND_INTERVAL) {
    room.send("move", {
      x: localPos.x,
      y: 0,
      z: localPos.z,
      rotationY: localRotY,
    });
    lastSend = now;
  }

  const lerp = Math.min(1, dt * 12);
  const animSmooth = 1 - Math.exp(-8 * dt);
  for (const [id, view] of players) {
    if (id !== mySessionId) {
      view.group.position.x += (view.target.x - view.group.position.x) * lerp;
      view.group.position.z += (view.target.z - view.group.position.z) * lerp;
      const dAngle =
        ((view.targetRotY - view.group.rotation.y + Math.PI * 3) %
          (Math.PI * 2)) -
        Math.PI;
      view.group.rotation.y += dAngle * lerp;
    }

    let running: boolean;
    if (id === mySessionId) {
      running = moving && canMove;
    } else {
      const dxv = view.group.position.x - view.lastPos.x;
      const dzv = view.group.position.z - view.lastPos.z;
      const speed = Math.hypot(dxv, dzv) / Math.max(0.001, dt);
      running = speed > 0.6 && view.alive;
    }
    view.lastPos.copy(view.group.position);

    if (view.mixer && view.idleAction && view.runAction) {
      if (!view.alive) {
        view.runAction.setEffectiveWeight(0);
        view.idleAction.setEffectiveWeight(0);
      } else {
        const currentRun = view.runAction.getEffectiveWeight();
        const targetRun = running ? 1 : 0;
        const newRun = currentRun + (targetRun - currentRun) * animSmooth;
        view.runAction.setEffectiveWeight(newRun);
        view.idleAction.setEffectiveWeight(1 - newRun);
      }
      view.mixer.update(dt);
    }

    if (view.avatar && view.avatar.rotation.y !== 0) {
      view.avatar.rotation.y = 0;
    }
    if (view.avatar) {
      view.avatar.visible = now >= view.riftHideUntil;
    }
    if (now < view.aoeSpinUntil && view.aoeSpinUntil > view.aoeSpinStart) {
      if (view.spineBone) {
        const elapsed = (now - view.aoeSpinStart) / 1000;
        const ANGULAR_SPEED = Math.PI * 2;
        const angle = (elapsed * ANGULAR_SPEED) % (Math.PI * 2);
        view.spineBone.quaternion.setFromEuler(new THREE.Euler(0, angle, 0));
      }
    }

    updatePlayerVisuals(view, now);
  }

  const focus = me?.group.position ?? null;
  if (focus) {
    camera.position.copy(focus).add(CAM_OFFSET);
    camera.lookAt(focus);
  } else {
    camera.position.set(CAM_OFFSET.x, CAM_OFFSET.y, CAM_OFFSET.z);
    camera.lookAt(0, 0, 0);
  }

  for (let i = effects.length - 1; i >= 0; i--) {
    if (!effects[i].update(now)) {
      effects[i].cleanup();
      effects.splice(i, 1);
    }
  }

  if (now < shakeUntil && shakeAmp > 0) {
    const remaining = Math.max(0, (shakeUntil - now) / shakeDuration);
    const a = shakeAmp * remaining;
    camera.position.x += (Math.random() - 0.5) * a;
    camera.position.y += (Math.random() - 0.5) * a;
  } else {
    shakeAmp = 0;
  }

  updateCooldownUI(now);

  if (me && targetingMode === "leap" && leapRangeRing && leapRangeRing.visible) {
    leapRangeRing.position.x = me.group.position.x;
    leapRangeRing.position.z = me.group.position.z;
  }
  if (me && targetingMode === "pull" && pullCone && pullCone.visible) {
    pullCone.position.x = me.group.position.x;
    pullCone.position.z = me.group.position.z;
  }

  composer.render();
  requestAnimationFrame(tick);
}

tick();
