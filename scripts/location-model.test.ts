import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('supplied apartment export contains cutaway architecture and the coloured person, with no competing full shell', async () => {
  const buffer = readFileSync(new URL('../public/media/location/apartment-111.glb', import.meta.url));
  assert.equal(buffer.subarray(0, 4).toString(), 'glTF');
  assert.equal(buffer.readUInt32LE(4), 2);
  assert.equal(buffer.readUInt32LE(8), buffer.length);
  const gltf = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString());
  const person = gltf.nodes.find((node: { name?: string }) => node.name === 'Person | 6 ft 3 in | lying on kitchen floor');
  assert.ok(person);
  assert.ok(gltf.nodes.some((node: { name?: string }) => node.name?.includes('Derived cutaway shell')));
  assert.equal(gltf.nodes.some((node: { name?: string }) => node.name?.includes('Full-height architectural shell')), false);
  assert.equal(gltf.nodes.some((node: { name?: string }) => node.name?.includes('Presentation ground')), false);
  assert.ok(gltf.meshes[person.mesh].primitives.every((primitive: { attributes: Record<string, number> }) => Object.hasOwn(primitive.attributes, 'COLOR_0')));
  // Parse the actual portable asset with the same loader as the UI, not an unrelated geometry fixture.
  const { GLTFLoader } = await import(new URL('../node_modules/three/examples/jsm/loaders/GLTFLoader.js', import.meta.url).href);
  const { Box3, Vector3 } = await import(new URL('../node_modules/three/build/three.module.js', import.meta.url).href);
  const binary = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const result = await new GLTFLoader().parseAsync(binary, '');
  let loadedPerson: any = null;
  result.scene.traverse((node: any) => { if (node.userData.name === person.name) loadedPerson = node; });
  assert.ok(loadedPerson, 'original node name survives in userData despite loader name sanitization');
  result.scene.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(loadedPerson);
  const center = bounds.getCenter(new Vector3());
  assert.ok(Math.abs(bounds.min.y - .001) < .005, 'the person stays on the floor after conversion to Y-up');
  assert.ok(center.x > 4 && center.x < 7 && center.z < -1 && center.z > -4, 'blue marker anchor is the supplied kitchen placement');
  assert.ok(bounds.max.y < .5, 'the supplied lying pose is retained');
});
