import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DOCTORS = [
  {
    id: "dr-elena-marsh",
    name: "Dr. Elena Marsh",
    specialization: "Internal Medicine",
    experience: "16 years",
    rating: 4.9,
    days: ["Mon", "Tue", "Thu", "Fri"],
    bio: "Leads our diagnostics team and holds a specialty in feline endocrinology.",
    initials: "EM",
    tags: ["Endocrinology", "Chronic disease", "Senior care", "Ultrasound"],
    pets: ["Dog", "Cat"],
  },
  {
    id: "dr-samir-haddad",
    name: "Dr. Samir Haddad",
    specialization: "Surgery & Orthopaedics",
    experience: "13 years",
    rating: 4.8,
    days: ["Mon", "Wed", "Thu"],
    bio: "Performs over 300 soft tissue and orthopaedic procedures each year.",
    initials: "SH",
    tags: ["Orthopaedics", "Soft tissue", "Cruciate repair", "Post-op rehab"],
    pets: ["Dog", "Cat"],
  },
  {
    id: "dr-nadia-osei",
    name: "Dr. Nadia Osei",
    specialization: "Emergency & Critical Care",
    experience: "11 years",
    rating: 5.0,
    days: ["Tue", "Wed", "Fri", "Sat"],
    bio: "Runs the overnight critical care rotation and our triage protocol.",
    initials: "NO",
    tags: ["Triage", "Critical care", "Trauma", "Overnight"],
    pets: ["Dog", "Cat", "Rabbit"],
  },
  {
    id: "dr-james-oconnell",
    name: "Dr. James O'Connell",
    specialization: "Dentistry & Oral Surgery",
    experience: "9 years",
    rating: 4.8,
    days: ["Wed", "Thu", "Sat"],
    bio: "Focused on pain-managed dental care for senior and small-breed patients.",
    initials: "JO",
    tags: ["Dental surgery", "Extractions", "Pain management", "Small breeds"],
    pets: ["Dog", "Cat"],
  },
  {
    id: "dr-priya-raman",
    name: "Dr. Priya Raman",
    specialization: "Dermatology & Allergy",
    experience: "10 years",
    rating: 4.9,
    days: ["Mon", "Tue", "Fri"],
    bio: "Builds long-term plans for chronic skin, ear and allergy conditions.",
    initials: "PR",
    tags: ["Allergy testing", "Ear disease", "Skin cytology", "Immunotherapy"],
    pets: ["Dog", "Cat"],
  },
  {
    id: "dr-tomas-lindqvist",
    name: "Dr. Tomas Lindqvist",
    specialization: "Exotics & Small Mammals",
    experience: "14 years",
    rating: 4.7,
    days: ["Tue", "Thu", "Sat"],
    bio: "Cares for rabbits, reptiles and birds with species-specific protocols.",
    initials: "TL",
    tags: ["Exotics anaesthesia", "Avian medicine", "Dental burring", "Husbandry"],
    pets: ["Rabbit", "Bird", "Reptile", "Ferret", "Guinea Pig"],
  },
];

const SERVICES = [
  { slug: "general-checkup", icon: "Stethoscope", title: "General Checkup", description: "Full physical exams with a written wellness plan after every visit." },
  { slug: "vaccination", icon: "Syringe", title: "Vaccination", description: "Core and lifestyle vaccines, tracked with automatic due-date reminders." },
  { slug: "surgery", icon: "Scissors", title: "Surgery", description: "Soft tissue and orthopaedic procedures in a dedicated sterile theatre." },
  { slug: "emergency", icon: "Siren", title: "Emergency Care", description: "Triage within minutes, any hour, with on-call critical care staff." },
  { slug: "laboratory", icon: "FlaskConical", title: "Laboratory", description: "In-house bloodwork and cytology with same-visit results." },
  { slug: "dental", icon: "Sparkles", title: "Dental Care", description: "Scaling, polishing and extractions under monitored anaesthesia." },
  { slug: "pharmacy", icon: "Pill", title: "Pharmacy", description: "Dispensed on site, dosage verified against your pet's chart." },
  { slug: "grooming", icon: "Bath", title: "Grooming", description: "Medicated baths and coat care supervised by clinical staff." },
  { slug: "nutrition", icon: "Salad", title: "Nutrition", description: "Weight and diet programmes built around measurable targets." },
  { slug: "x-ray", icon: "ScanLine", title: "Digital X-Ray", description: "Low-dose digital radiography read within the same appointment." },
  { slug: "ultrasound", icon: "Activity", title: "Ultrasound", description: "Abdominal and cardiac imaging performed by certified sonographers." },
  { slug: "records", icon: "FolderHeart", title: "Digital Records", description: "Every visit, result and prescription in one shareable history." },
];

const SETTINGS = {
  id: 1,
  name: "Paw-M",
  tagline: "Veterinary care, quietly excellent.",
  phone: "+1 (415) 555-0142",
  emergency: "+1 (415) 555-0911",
  whatsapp: "+1 (415) 555-0142",
  email: "hello@paw-m.clinic",
  address: "218 Marlow Street, Suite 4 \u00b7 San Francisco, CA 94110",
  currency: "$",
  instapay: "",
};

const PRODUCTS = [
  { id: "prod-senior-dry", name: "Senior Complete Dry Food — Chicken & Rice", description: "Balanced complete nutrition for senior dogs, with glucosamine for joint support and a gentle recipe for sensitive stomachs.", price: 34.99, compareAtPrice: 39.99, category: "food", petType: "dog", stock: 24, featured: true, image: "https://images.unsplash.com/photo-1589924691995-400dc9ecc119?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-cat-salmon", name: "Grain-Free Salmon Recipe — Adult Cats", description: "Protein-first grain-free recipe for adult cats, rich in omega-3s for healthy skin and a shiny coat.", price: 29.5, compareAtPrice: null, category: "food", petType: "cat", stock: 18, featured: true, image: "https://images.unsplash.com/photo-1583511655857-d19b40a7a54e?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-puppy-growth", name: "Puppy Growth Formula — Small Breeds", description: "DHA-enriched kibble sized for small-breed puppies from weaning to 12 months.", price: 26.75, compareAtPrice: 29.75, category: "food", petType: "dog", stock: 31, featured: false, image: "https://images.unsplash.com/photo-1552053831-71594a27632d?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-duck-treats", name: "Soft Chew Training Treats — Duck", description: "Low-calorie soft treats with real duck, perfect for training sessions and rewards.", price: 12.99, compareAtPrice: null, category: "treats", petType: "both", stock: 42, featured: true, image: "https://images.unsplash.com/photo-1543466835-00a7907e9de1?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-dental-sticks", name: "Dental Stick Multipack — Mint", description: "Daily dental chews that help reduce tartar and freshen breath, in a mint flavour dogs love.", price: 16.5, compareAtPrice: 19.99, category: "treats", petType: "dog", stock: 37, featured: false, image: "https://images.unsplash.com/photo-1601758228041-f3b2795255f1?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-chicken-bites", name: "Freeze-Dried Chicken Bites", description: "Single-ingredient freeze-dried chicken treats with no fillers — great for allergy-sensitive pets.", price: 14.25, compareAtPrice: null, category: "treats", petType: "both", stock: 26, featured: false, image: "https://images.unsplash.com/photo-1517849845537-4d2579024541?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-tennis-trio", name: "Squeaky Tennis Ball Trio", description: "Durable, non-toxic squeaky balls that bounce true and survive heavy chewers.", price: 9.99, compareAtPrice: null, category: "toys", petType: "dog", stock: 55, featured: true, image: "https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-feather-wand", name: "Feather Wand Cat Toy — 2 Pack", description: "Interactive feather wand with a replaceable lure, built for hours of pouncing.", price: 11.49, compareAtPrice: 13.49, category: "toys", petType: "cat", stock: 48, featured: false, image: "https://images.unsplash.com/photo-1545249390-6bdfa286032f?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-snuffle-mat", name: "Snuffle Mat — Slow Feeding Enrichment", description: "Hide treats in the fleece folds to slow fast eaters and give noses a workout.", price: 19.99, compareAtPrice: null, category: "toys", petType: "both", stock: 21, featured: false, image: "https://images.unsplash.com/photo-1583337130417-3346a1be7dee?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-oatmeal-shampoo", name: "Oatmeal & Aloe Conditioning Shampoo", description: "pH-balanced hypoallergenic shampoo with oatmeal and aloe for itchy, dry skin.", price: 15.99, compareAtPrice: null, category: "grooming", petType: "both", stock: 33, featured: true, image: "https://images.unsplash.com/photo-1516734212186-a967f81ad0d7?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-grooming-brush", name: "Self-Cleaning Grooming Brush", description: "One-touch grooming brush that collects loose fur and massages the skin.", price: 13.75, compareAtPrice: 16.99, category: "grooming", petType: "both", stock: 29, featured: false, image: "https://images.unsplash.com/photo-1583511666407-5f06533f2113?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-nail-grinder", name: "Nail Grinder Kit — 4 Heads", description: "Quiet, cordless grinder with four grinding heads for a smooth, safe trim.", price: 27.99, compareAtPrice: null, category: "grooming", petType: "both", stock: 17, featured: false, image: "https://images.unsplash.com/photo-1541599465904-9a3c2b6d9c0e?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-flea-tick", name: "Flea & Tick Prevention — 3 Month Dose", description: "Veterinary-grade topical prevention for dogs and cats, supplied with an application chart.", price: 44.99, compareAtPrice: 49.99, category: "health", petType: "both", stock: 15, featured: true, image: "https://images.unsplash.com/photo-1574158622682-e40e69881006?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-probiotic", name: "Probiotic Digestive Support Powder", description: "Daily probiotic blend that supports gut health during diet changes or after antibiotics.", price: 22.5, compareAtPrice: null, category: "health", petType: "both", stock: 20, featured: false, image: "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-joint-chews", name: "Joint Care Chews — Glucosamine & Chondroitin", description: "Tasty chews for stiff joints, formulated for older and active working dogs.", price: 25.99, compareAtPrice: null, category: "health", petType: "dog", stock: 22, featured: false, image: "https://images.unsplash.com/photo-1568640347023-a616a30bc3bd?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-reflective-harness", name: "Reflective No-Pull Harness — M–XL", description: "Padded, reflective harness that reduces pulling and stays secure on walks.", price: 21.99, compareAtPrice: 24.99, category: "accessories", petType: "dog", stock: 40, featured: true, image: "https://images.unsplash.com/photo-1591943379055-41e6234f3e93?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-travel-bowls", name: "Collapsible Travel Bowl Duo", description: "Two leak-proof silicone bowls that fold flat for walks, travel and the car.", price: 13.25, compareAtPrice: null, category: "accessories", petType: "both", stock: 36, featured: false, image: "https://images.unsplash.com/photo-1548767797-d8c844163c4c?auto=format&fit=crop&w=800&q=80" },
  { id: "prod-memory-bed", name: "Orthopaedic Memory Foam Bed — Large", description: "Washable memory-foam bed with a supportive rim for older and arthritic pets.", price: 58.0, compareAtPrice: 68.0, category: "accessories", petType: "both", stock: 12, featured: true, image: "https://images.unsplash.com/photo-1541783245831-57d6fb0926d3?auto=format&fit=crop&w=800&q=80" },
];

const REVIEWS = [
  { productId: "prod-senior-dry", author: "Hannah Doyle", rating: 5, comment: "Our 11-year-old terrier loves this food and his coat looks better within three weeks.", status: "approved" },
  { productId: "prod-senior-dry", author: "Marcus Bell", rating: 4, comment: "Great quality, the senior blend is very gentle on sensitive stomachs.", status: "approved" },
  { productId: "prod-cat-salmon", author: "Aisha Rahman", rating: 5, comment: "Our Maine Coon refuses anything else now. Coat is noticeably shinier.", status: "approved" },
  { productId: "prod-cat-salmon", author: "Theo Marchetti", rating: 5, comment: "Both cats love the salmon recipe and no upset tummies at all.", status: "approved" },
  { productId: "prod-duck-treats", author: "Hannah Doyle", rating: 5, comment: "Soft enough to break up for training, and the duck smell isn't overpowering.", status: "approved" },
  { productId: "prod-duck-treats", author: "Nina Kowalski", rating: 4, comment: "Works perfectly as a high-value reward at the park.", status: "approved" },
  { productId: "prod-tennis-trio", author: "Marcus Bell", rating: 5, comment: "Survived a month with our chewer. The squeak is still going strong.", status: "approved" },
  { productId: "prod-oatmeal-shampoo", author: "Aisha Rahman", rating: 5, comment: "Vet recommended it for our itchy Shiba and it made a real difference.", status: "approved" },
  { productId: "prod-flea-tick", author: "Theo Marchetti", rating: 5, comment: "No fleas all summer, and the application chart was a nice touch.", status: "approved" },
  { productId: "prod-memory-bed", author: "Nina Kowalski", rating: 5, comment: "Our senior greyhound finally sleeps through the night on this bed.", status: "approved" },
  { productId: "prod-senior-dry", author: "Lina Farouk", rating: 5, comment: "Picked it up at the clinic during a checkup — delivery was quick.", status: "pending" },
  { productId: "prod-reflective-harness", author: "Omar Saleh", rating: 4, comment: "Solid harness, the reflective strips are great for night walks.", status: "pending" },
];

async function main() {
  for (const doctor of DOCTORS) {
    await prisma.doctor.upsert({
      where: { id: doctor.id },
      update: doctor,
      create: doctor,
    });
  }

  for (const service of SERVICES) {
    await prisma.service.upsert({
      where: { slug: service.slug },
      update: service,
      create: service,
    });
  }

  for (const product of PRODUCTS) {
    await prisma.product.upsert({
      where: { id: product.id },
      update: product,
      create: product,
    });
  }

  for (const review of REVIEWS) {
    await prisma.review.create({
      data: review,
    });
  }

  await prisma.clinicSettings.upsert({
    where: { id: 1 },
    update: SETTINGS,
    create: SETTINGS,
  });

  console.log("[Paw-M] Database seeded: doctors, services, products, reviews, settings");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());