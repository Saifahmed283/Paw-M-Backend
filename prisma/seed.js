import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DOCTORS = [
  {
    id: "dr-mirna",
    name: "Dr. Mirna",
    specialization: "Veterinarian",
    experience: "10+ years",
    rating: 4.9,
    days: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    bio: "Experienced veterinarian trusted by hundreds of pet owners across Madinaty. Known for gentle handling, thorough diagnostics and 24/7 post-procedure follow-up.",
    initials: "DM",
    tags: ["Veterinary Consultation", "Surgery", "Spaying & Neutering", "Dental Care", "Exotics"],
    pets: ["Dog", "Cat", "Bird", "Rabbit", "Reptile"],
  },
];

const SERVICES = [
  { slug: "general-checkup", icon: "Stethoscope", title: "Veterinary Consultation & Health Checkup", description: "Comprehensive physical exams and wellness assessments for all pets." },
  { slug: "vaccination", icon: "Syringe", title: "Vaccinations for Dogs & Cats", description: "Core and lifestyle vaccination protocols for dogs and cats of all ages." },
  { slug: "surgery", icon: "Scissors", title: "Surgery", description: "Routine and advanced surgical procedures including soft-tissue and orthopaedic surgery." },
  { slug: "spay-neuter", icon: "Heart", title: "Spaying & Neutering", description: "Safe spay and neuter procedures with post-operative care instructions." },
  { slug: "dental", icon: "Sparkles", title: "Dental Care", description: "Dental scaling, polishing and extractions under monitored anaesthesia." },
  { slug: "laboratory", icon: "FlaskConical", title: "Laboratory & Blood Tests", description: "In-house bloodwork and laboratory diagnostics with same-visit results." },
  { slug: "pharmacy", icon: "Pill", title: "Pharmacy", description: "On-site dispensing with dosage verified against your pet's treatment chart." },
  { slug: "grooming", icon: "Bath", title: "Grooming", description: "Medicated baths, nail trims and coat care supervised by clinical staff." },
  { slug: "boarding", icon: "Home", title: "Boarding", description: "Safe and comfortable pet boarding with daily check-ups by our veterinary team." },
  { slug: "parasite", icon: "Bug", title: "Parasite Treatment", description: "Prevention and treatment for fleas, ticks, worms and other internal parasites." },
  { slug: "microchip", icon: "Cpu", title: "Microchipping", description: "ISO-standard microchip implantation and national registry registration." },
  { slug: "exotics", icon: "Bird", title: "Birds & Exotic Animals", description: "Specialised care for birds, rabbits, reptiles and exotic companion species." },
];

const SETTINGS = {
  id: 1,
  name: "Paw Clinic Madinaty",
  tagline: "Veterinary care with love, under the care of Dr. Mirna.",
  phone: "012 10105624",
  emergency: "012 10105624",
  whatsapp: "012 10105624",
  email: "hello@pawclinicmadinaty.com",
  address: "Craft Zoon, Second New Cairo, Cairo Governorate 19519",
  currency: "EGP",
  instapay: "",
  googlePlacesKey: "",
  googlePlacesId: "",
  rolePermissions: {
    admin: [
      "overview",
      "requests",
      "staff-overview",
      "payroll",
      "tasks",
      "notifications",
      "reservations",
      "doctors",
      "services",
      "products",
      "orders",
      "reviews",
      "workdays",
      "archive",
      "logs",
      "settings",
    ],
    payroll: [
      "overview",
      "requests",
      "notifications",
      "reservations",
      "payroll",
      "doctors",
      "services",
      "products",
      "orders",
      "reviews",
      "workdays",
      "archive",
    ],
    staff: ["overview", "requests", "notifications", "tasks", "reservations"],
  },
};

const DEMO_SETTINGS = {
  name: "Paw Clinic Madinaty",
  tagline: "4.9 · 25 Google Reviews — Veterinary care with love.",
  phone: "012 10105624",
  emergency: "012 10105624",
  whatsapp: "012 10105624",
  email: "hello@pawclinicmadinaty.com",
  address: "Craft Zoon, Second New Cairo, Cairo Governorate 19519",
  currency: "EGP",
  instapay: "",
  googlePlacesKey: "",
  googlePlacesId: "ChIJ7eN6m8f1VxQRShQLeEdq4pU",
};

const PRODUCTS = [
  { id: "prod-senior-dry", name: "Senior Complete Dry Food 🐔 & Rice", description: "Balanced complete nutrition for senior dogs, with glucosamine for joint support and a gentle recipe for sensitive stomachs.", price: 34.99, compareAtPrice: 39.99, category: "food", petType: "dog", stock: 24, featured: true, image: "https://images.unsplash.com/photo-1589924691995-400dc9ecc119?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-cat-salmon", name: "Grain-Free Salmon Recipe 🐈 Adult Cats", description: "Protein-first grain-free recipe for adult cats, rich in omega-3s for healthy skin and a shiny coat.", price: 29.5, compareAtPrice: null, category: "food", petType: "cat", stock: 18, featured: true, image: "https://images.unsplash.com/photo-1583511655857-d19b40a7a54e?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-puppy-growth", name: "Puppy Growth Formula 🐕 Small Breeds", description: "DHA-enriched kibble sized for small-breed puppies from weaning to 12 months.", price: 26.75, compareAtPrice: 29.75, category: "food", petType: "dog", stock: 31, featured: false, image: "https://images.unsplash.com/photo-1552053831-71594a27632d?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-duck-treats", name: "Soft Chew Training Treats 🦆 Duck", description: "Low-calorie soft treats with real duck, perfect for training sessions and rewards.", price: 12.99, compareAtPrice: null, category: "treats", petType: "both", stock: 42, featured: true, image: "https://images.unsplash.com/photo-1543466835-00a7907e9de1?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-dental-sticks", name: "Dental Stick Multipack 🌿 Mint", description: "Daily dental chews that help reduce tartar and freshen breath, in a mint flavour dogs love.", price: 16.5, compareAtPrice: 19.99, category: "treats", petType: "dog", stock: 37, featured: false, image: "https://images.unsplash.com/photo-1601758228041-f3b2795255f1?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-chicken-bites", name: "Freeze-Dried Chicken Bites", description: "Single-ingredient freeze-dried chicken treats with no fillers 🍗 great for allergy-sensitive pets.", price: 14.25, compareAtPrice: null, category: "treats", petType: "both", stock: 26, featured: false, image: "https://images.unsplash.com/photo-1517849845537-4d2579024541?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-tennis-trio", name: "Squeaky Tennis Ball Trio", description: "Durable, non-toxic squeaky balls that bounce true and survive heavy chewers.", price: 9.99, compareAtPrice: null, category: "toys", petType: "dog", stock: 55, featured: true, image: "https://images.unsplash.com/photo-1548199973-03cce0bbc87b?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-feather-wand", name: "Feather Wand Cat Toy 🐈 2 Pack", description: "Interactive feather wand with a replaceable lure, built for hours of pouncing.", price: 11.49, compareAtPrice: 13.49, category: "toys", petType: "cat", stock: 48, featured: false, image: "https://images.unsplash.com/photo-1545249390-6bdfa286032f?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-snuffle-mat", name: "Snuffle Mat 🐕‍🦺 Slow Feeding Enrichment", description: "Hide treats in the fleece folds to slow fast eaters and give noses a workout.", price: 19.99, compareAtPrice: null, category: "toys", petType: "both", stock: 21, featured: false, image: "https://images.unsplash.com/photo-1583337130417-3346a1be7dee?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-oatmeal-shampoo", name: "Oatmeal & Aloe Conditioning Shampoo", description: "pH-balanced hypoallergenic shampoo with oatmeal and aloe for itchy, dry skin.", price: 15.99, compareAtPrice: null, category: "grooming", petType: "both", stock: 33, featured: true, image: "https://images.unsplash.com/photo-1516734212186-a967f81ad0d7?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-grooming-brush", name: "Self-Cleaning Grooming Brush", description: "One-touch grooming brush that collects loose fur and massages the skin.", price: 13.75, compareAtPrice: 16.99, category: "grooming", petType: "both", stock: 29, featured: false, image: "https://images.unsplash.com/photo-1583511666407-5f06533f2113?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-nail-grinder", name: "Nail Grinder Kit 🔧 4 Heads", description: "Quiet, cordless grinder with four grinding heads for a smooth, safe trim.", price: 27.99, compareAtPrice: null, category: "grooming", petType: "both", stock: 17, featured: false, image: "https://images.unsplash.com/photo-1541599465904-9a3c2b6d9c0e?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-flea-tick", name: "Flea & Tick Prevention 🐾 3 Month Dose", description: "Veterinary-grade topical prevention for dogs and cats, supplied with an application chart.", price: 44.99, compareAtPrice: 49.99, category: "health", petType: "both", stock: 15, featured: true, image: "https://images.unsplash.com/photo-1574158622682-e40e69881006?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-probiotic", name: "Probiotic Digestive Support Powder", description: "Daily probiotic blend that supports gut health during diet changes or after antibiotics.", price: 22.5, compareAtPrice: null, category: "health", petType: "both", stock: 20, featured: false, image: "https://images.unsplash.com/photo-1514888286974-6c03e2ca1dba?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-joint-chews", name: "Joint Care Chews 🐾 Glucosamine & Chondroitin", description: "Tasty chews for stiff joints, formulated for older and active working dogs.", price: 25.99, compareAtPrice: null, category: "health", petType: "dog", stock: 22, featured: false, image: "https://images.unsplash.com/photo-1568640347023-a616a30bc3bd?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-reflective-harness", name: "Reflective No-Pull Harness 🐾 M–XL", description: "Padded, reflective harness that reduces pulling and stays secure on walks.", price: 21.99, compareAtPrice: 24.99, category: "accessories", petType: "dog", stock: 40, featured: true, image: "https://images.unsplash.com/photo-1591943379055-41e6234f3e93?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-travel-bowls", name: "Collapsible Travel Bowl Duo", description: "Two leak-proof silicone bowls that fold flat for walks, travel and the car.", price: 13.25, compareAtPrice: null, category: "accessories", petType: "both", stock: 36, featured: false, image: "https://images.unsplash.com/photo-1548767797-d8c844163c4c?auto=format&fit=crop&w=800&q=80", barcode: null },
  { id: "prod-memory-bed", name: "Orthopaedic Memory Foam Bed 🛏️ Large", description: "Washable memory-foam bed with a supportive rim for older and arthritic pets.", price: 58.0, compareAtPrice: 68.0, category: "accessories", petType: "both", stock: 12, featured: true, image: "https://images.unsplash.com/photo-1541783245831-57d6fb0926d3?auto=format&fit=crop&w=800&q=80", barcode: null },
];

const REVIEWS = [
  { id: "google-mariem-mahmoud", productId: "clinic", author: "Mariem Mahmoud", rating: 5, comment: "Had such a great experience with Dr. Mirna. She was so kind and patient with my cat, and took her time to check him and explain everything.", status: "approved" },
  { id: "google-rim-ibrahim", productId: "clinic", author: "Rim Ibrahim", rating: 5, comment: "The most amazing service and products.", status: "approved" },
  { id: "google-ahmed-eng", productId: "clinic", author: "Ahmed Eng", rating: 5, comment: "Very nice new admin. Nice treat and service.", status: "approved" },
  { id: "google-marina-emad", productId: "clinic", author: "Marina Emad", rating: 5, comment: "Perfect hospitality for my dog when I was out of my country, and every product I need for my dog is available at their shop.", status: "approved" },
  { id: "google-nahla-sherif", productId: "clinic", author: "Nahla Sherif", rating: 5, comment: "My cat had a critical case of bladder blockage and Dr. Mirna was really professional in diagnosing the case and following up with me every day.", status: "approved" },
  { id: "google-adam-agha", productId: "clinic", author: "Adam Agha", rating: 5, comment: "Dr. Mirna is very respectful, professional, and experienced. I took my cat for a neutering procedure based on a recommendation from a friend.", status: "approved" },
  { id: "google-aziz-ali", productId: "clinic", author: "Aziz Ali", rating: 5, comment: "The clinic is absolutely fantastic, and the doctor is lovely and does a great job.", status: "approved" },
  { id: "google-nehal-nasef", productId: "clinic", author: "Nehal Nasef", rating: 5, comment: "My favorite vet and pet clinic. They are professional and I highly recommend them to anyone.", status: "approved" },
  { id: "google-hatem-el-mandarawi", productId: "clinic", author: "Hatem El Mandarawi", rating: 5, comment: "Amazing clinic, very professional and extremely caring. After a surgery, the team kept checking in to make sure everything was fine.", status: "approved" },
  { id: "google-marian-tadros", productId: "clinic", author: "Marian Tadros", rating: 5, comment: "One of the most comfortable pet clinics I've ever been to. Dr. Mirna is a very skilled doctor.", status: "approved" },
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

const STAFF_ACCOUNTS = [
  { username: "admin", password: "admin123", role: "admin" },
  { username: "payroll", password: "payroll123", role: "payroll" },
  { username: "staff", password: "staff123", role: "staff" },
];

const EMPLOYEES = [
  {
    fullName: "Admin User",
    email: "admin@pawclinicmadinaty.com",
    role: "admin",
    hourlyRate: 150,
    monthlySalary: 5000,
    payRateType: "monthly",
    roleHoursPerDay: 8,
  },
  {
    fullName: "Payroll Staff",
    email: "payroll@pawclinicmadinaty.com",
    role: "payroll",
    hourlyRate: 80,
    monthlySalary: 3200,
    payRateType: "monthly",
    roleHoursPerDay: 8,
  },
  {
    fullName: "Clinic Staff",
    email: "staff@pawclinicmadinaty.com",
    role: "staff",
    hourlyRate: 45,
    monthlySalary: 0,
    payRateType: "hourly",
    roleHoursPerDay: 8,
  },
];

async function main() {
  const bcrypt = await import("bcryptjs");
  const BCRYPT_ROUNDS = 12;

  for (const account of STAFF_ACCOUNTS) {
    const existing = await prisma.adminUser.findUnique({
      where: { username: account.username },
    });
    if (!existing) {
      const salt = bcrypt.genSaltSync(BCRYPT_ROUNDS);
      const hash = bcrypt.hashSync(account.password, salt);
      await prisma.adminUser.create({
        data: { username: account.username, salt, hash, role: account.role },
      });
      console.log(`[Paw-M] Created staff account: ${account.username} (${account.role})`);
    }
  }

  for (const emp of EMPLOYEES) {
    await prisma.employee.upsert({
      where: { email: emp.email },
      update: emp,
      create: emp,
    });
  }

  for (const doctor of DOCTORS) {
    await prisma.doctor.createMany({ data: [doctor], skipDuplicates: true });
  }

  for (const service of SERVICES) {
    await prisma.service.createMany({ data: [service], skipDuplicates: true });
  }

  for (const product of PRODUCTS) {
    await prisma.product.createMany({ data: [product], skipDuplicates: true });
  }

  for (const review of REVIEWS) {
    const exists = await prisma.review.findFirst({
      where: {
        productId: review.productId,
        author: review.author,
        comment: review.comment,
      },
    });
    if (!exists) await prisma.review.create({ data: review });
  }

  const existingSettings = await prisma.clinicSettings.findUnique({ where: { id: 1 } });
  if (!existingSettings) {
    await prisma.clinicSettings.create({ data: SETTINGS });
  } else if (
    existingSettings.tagline === DEMO_SETTINGS.tagline ||
    existingSettings.googlePlacesId === DEMO_SETTINGS.googlePlacesId ||
    !existingSettings.rolePermissions ||
    Object.keys(existingSettings.rolePermissions).length === 0
  ) {
    await prisma.clinicSettings.update({ where: { id: 1 }, data: SETTINGS });
  }

  console.log("[Paw-M] Database seeded: staff accounts, employees, doctors, services, products, reviews, settings");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());